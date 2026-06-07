const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
const originalEnv = {
  ALLOW_LOCAL_NETWORK: process.env.ALLOW_LOCAL_NETWORK,
  NODE_ENV: process.env.NODE_ENV,
};

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

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function deleteIfCached(relativePath) {
  try {
    const resolved = require.resolve(path.join(root, relativePath));
    delete require.cache[resolved];
  } catch {
    // Ignore optional modules in source-level contract tests.
  }
}

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

test.afterEach(() => {
  restoreEnv();
  Module._load = originalLoad;
  deleteIfCached('src/lib/ssrf-guard.ts');
  deleteIfCached('next.config.ts');
});

test('SSRF guard allows public IP literals by default', async () => {
  delete process.env.ALLOW_LOCAL_NETWORK;
  const { assertSafeUrl } = require('../src/lib/ssrf-guard.ts');

  const url = await assertSafeUrl('https://8.8.8.8/v1/models');

  assert.equal(url.hostname, '8.8.8.8');
});

test('SSRF guard rejects loopback, RFC1918, IPv6 ULA, and IPv6 site-local addresses by default', async () => {
  delete process.env.ALLOW_LOCAL_NETWORK;
  const { assertSafeUrl } = require('../src/lib/ssrf-guard.ts');
  const blockedUrls = [
    'http://127.0.0.1/v1/models',
    'http://10.0.0.5/v1/models',
    'http://172.16.0.5/v1/models',
    'http://192.168.1.5/v1/models',
    'http://[::1]/v1/models',
    'http://[fc00::1]/v1/models',
    'http://[fd12::1]/v1/models',
    'http://[fec0::1]/v1/models',
  ];

  for (const rawUrl of blockedUrls) {
    await assert.rejects(
      () => assertSafeUrl(rawUrl),
      /SSRF 防护拒绝/,
      `${rawUrl} should be rejected`,
    );
  }
});

test('SSRF guard rejects redirects from a public URL to an internal URL', async () => {
  delete process.env.ALLOW_LOCAL_NETWORK;
  const fetchCalls = [];
  const { safeFetch } = requireFreshWithMocks('../src/lib/ssrf-guard.ts', {
    undici: {
      Agent: class Agent {
        constructor(options) {
          this.options = options;
        }
      },
      buildConnector: () => () => {
        throw new Error('mock connector should not be used by mocked fetch');
      },
      fetch: async url => {
        fetchCalls.push(url);
        return new Response('', {
          status: 302,
          headers: { location: 'http://127.0.0.1/admin' },
        });
      },
    },
  });

  await assert.rejects(
    () => safeFetch('https://8.8.8.8/start'),
    /SSRF 防护拒绝/,
  );
  assert.deepEqual(fetchCalls, ['https://8.8.8.8/start']);
});

test('SSRF socket guard rejects IPv4-mapped IPv6 loopback in hexadecimal form', async () => {
  delete process.env.ALLOW_LOCAL_NETWORK;
  const socket = {
    remoteAddress: '::ffff:7f00:1',
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  const { safeFetch } = requireFreshWithMocks('../src/lib/ssrf-guard.ts', {
    undici: {
      Agent: class Agent {
        constructor(options) {
          this.options = options;
        }
      },
      buildConnector: () => (_opts, callback) => callback(null, socket),
      fetch: async (_url, init) => new Promise((resolve, reject) => {
        init.dispatcher.options.connect({}, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(new Response('ok'));
        });
      }),
    },
  });

  await assert.rejects(
    () => safeFetch('https://8.8.8.8/start'),
    /SSRF 防护拒绝/,
  );
  assert.equal(socket.destroyed, true);
});

test('production CSP connect-src does not allow unconditional cleartext ws:', async () => {
  process.env.NODE_ENV = 'production';
  deleteIfCached('next.config.ts');
  const config = require('../next.config.ts').default;
  const headers = await config.headers();
  const csp = headers[0].headers.find(header => header.key === 'Content-Security-Policy').value;
  const connectSrc = csp.split(';').map(part => part.trim()).find(part => part.startsWith('connect-src '));

  assert.ok(connectSrc, 'connect-src directive should exist');
  assert.doesNotMatch(connectSrc, /(?:^|\s)ws:(?:\s|$)/);
});

test('release docs structure contract describes proxy trust, env file override, CI Node matrix, and production password requirements', () => {
  const envExample = fs.readFileSync(path.join(root, '.env.local.example'), 'utf8');
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  const readmeZh = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const readmeEn = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const entrypoint = fs.readFileSync(path.join(root, 'docker-entrypoint.sh'), 'utf8');
  const docs = `${claude}\n${readmeZh}\n${readmeEn}`;

  assert.match(envExample, /TRUST_PROXY/);
  assert.match(envExample, /X-Forwarded-For|反向代理|reverse proxy/i);
  assert.match(docs, /TRUST_PROXY/);
  assert.match(docs, /LUMIMUSE_ENV_FILE/);
  assert.match(docs, /20\.18/);
  assert.match(docs, /Node 24/);
  assert.match(compose, /\$\{LUMIMUSE_ENV_FILE:-\.env\.local\}/);
  assert.match(`${entrypoint}\n${docs}`, /ACCESS_PASSWORD/);
  assert.match(`${entrypoint}\n${docs}`, /your_password_here|placeholder|占位/);
  assert.match(`${entrypoint}\n${docs}`, /fail-fast|refuse|拒绝|失败/i);
});

test('Docker release config exposes an application healthcheck', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const releaseConfig = `${dockerfile}\n${compose}`;

  assert.match(releaseConfig, /HEALTHCHECK|healthcheck/);
  assert.match(releaseConfig, /\/api\/health/);
  assert.match(releaseConfig, /127\.0\.0\.1:3000/);
});
