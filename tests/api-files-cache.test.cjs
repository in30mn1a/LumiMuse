const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const originalLoad = Module._load;

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

function requireFreshWithMocks(modulePath, mocks) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

class NextResponseMock {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
  }
}

const mockFileStat = {
  size: 1234,
  mtimeMs: 1710000000000,
  mtime: new Date('2026-06-05T12:00:00.000Z'),
};

function loadFilesRoute(extraFs = {}) {
  return requireFreshWithMocks('../src/app/api/files/[...path]/route.ts', {
    'next/server': { NextResponse: NextResponseMock },
    'fs/promises': {
      stat: async () => mockFileStat,
      readFile: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      ...extraFs,
    },
  });
}

function requestWithHeaders(headers = {}) {
  return { headers: new Headers(headers) };
}

async function getFileResponse(route, dir, filename, headers) {
  return route.GET(
    requestWithHeaders(headers),
    { params: Promise.resolve({ path: [dir, filename] }) },
  );
}

test('/api/files generated images use one year private browser cache', async () => {
  const route = loadFilesRoute();

  const response = await getFileResponse(route, 'generated', 'sample.png');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
});

test('/api/files generated image 304 responses keep one year private browser cache', async () => {
  const route = loadFilesRoute();
  const etag = `"${mockFileStat.size.toString(16)}-${mockFileStat.mtimeMs.toString(16)}"`;

  const response = await getFileResponse(route, 'generated', 'sample.png', {
    'If-None-Match': etag,
  });

  assert.equal(response.status, 304);
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
});

test('/api/files avatars use one year private browser cache', async () => {
  const route = loadFilesRoute();

  const response = await getFileResponse(route, 'avatars', 'avatar.png');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
});

test('/api/files attachments keep one week private browser cache', async () => {
  const route = loadFilesRoute();

  const response = await getFileResponse(route, 'attachments', 'attachment.png');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=604800, immutable');
});
