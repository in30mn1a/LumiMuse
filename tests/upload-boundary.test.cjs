const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

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

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          body,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function createUploadHarness() {
  const writes = [];
  const mkdirs = [];
  const route = requireFreshWithMocks('../src/app/api/upload/route.ts', {
    'next/server': jsonResponseMock(),
    'fs/promises': {
      async mkdir(dir, options) {
        mkdirs.push({ dir, options });
      },
      async writeFile(filePath, buffer) {
        writes.push({ filePath, size: buffer.byteLength });
      },
    },
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
  });

  return { route, writes, mkdirs };
}

function uploadRequest({ contentLength, file, purpose, formDataImpl }) {
  return {
    headers: {
      get(name) {
        if (name.toLowerCase() !== 'content-length') return null;
        return contentLength == null ? null : String(contentLength);
      },
    },
    async formData() {
      if (formDataImpl) return formDataImpl();
      return {
        get(name) {
          if (name === 'avatar') return file;
          if (name === 'purpose') return purpose;
          return null;
        },
      };
    },
  };
}

function imageFile({ name = 'avatar.png', type = 'image/png', size, bytes }) {
  const data = bytes || Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);
  return {
    name,
    type,
    size: size ?? data.byteLength,
    async arrayBuffer() {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    },
  };
}

test('/api/upload rejects oversized Content-Length before formData is parsed', async () => {
  const { route, writes } = createUploadHarness();
  let formDataCalled = false;

  const response = await route.POST(uploadRequest({
    contentLength: 10 * 1024 * 1024 + 1,
    formDataImpl() {
      formDataCalled = true;
      throw new Error('formData should not be called');
    },
  }));
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.error, '文件过大（最大 10MB）');
  assert.equal(formDataCalled, false);
  assert.deepEqual(writes, []);
});

test('/api/upload rejects missing Content-Length when actual file size is too large before writing', async () => {
  const { route, writes, mkdirs } = createUploadHarness();

  const response = await route.POST(uploadRequest({
    contentLength: null,
    purpose: 'attachment',
    file: imageFile({ size: 10 * 1024 * 1024 + 1 }),
  }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, '文件过大（最大 10MB）');
  assert.deepEqual(mkdirs, []);
  assert.deepEqual(writes, []);
});

test('/api/upload rejects understated Content-Length when actual file size is too large before writing', async () => {
  const { route, writes, mkdirs } = createUploadHarness();

  const response = await route.POST(uploadRequest({
    contentLength: 1024,
    purpose: 'attachment',
    file: imageFile({ size: 10 * 1024 * 1024 + 1 }),
  }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, '文件过大（最大 10MB）');
  assert.deepEqual(mkdirs, []);
  assert.deepEqual(writes, []);
});

test('/api/upload accepts a normal small image upload', async () => {
  const { route, writes, mkdirs } = createUploadHarness();

  const response = await route.POST(uploadRequest({
    contentLength: 1024,
    purpose: 'avatar',
    file: imageFile({ size: 12 }),
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.url, '/api/files/avatars/11111111-1111-4111-8111-111111111111.png');
  assert.equal(mkdirs.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].size, 12);
});
