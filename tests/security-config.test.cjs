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

test('safeFetch retains credentials across same-origin redirects', async () => {
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
      fetch: async (url, init) => {
        fetchCalls.push({ url, headers: new Headers(init.headers) });
        if (fetchCalls.length === 1) {
          return new Response('', { status: 302, headers: { location: '/finish' } });
        }
        return new Response('ok');
      },
    },
  });

  const response = await safeFetch('https://8.8.8.8/start', {
    headers: {
      Authorization: 'Bearer secret-token',
      Cookie: 'session=secret-cookie',
      'X-Trace-Id': 'trace-1',
    },
  });

  assert.equal(await response.text(), 'ok');
  assert.deepEqual(fetchCalls.map(call => call.url), [
    'https://8.8.8.8/start',
    'https://8.8.8.8/finish',
  ]);
  for (const call of fetchCalls) {
    assert.equal(call.headers.get('authorization'), 'Bearer secret-token');
    assert.equal(call.headers.get('cookie'), 'session=secret-cookie');
    assert.equal(call.headers.get('x-trace-id'), 'trace-1');
  }
});

test('safeFetch permanently strips credential headers after a cross-origin redirect', async () => {
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
      fetch: async (url, init) => {
        fetchCalls.push({ url, headers: new Headers(init.headers) });
        if (fetchCalls.length === 1) {
          return new Response('', { status: 302, headers: { location: 'https://1.1.1.1/away' } });
        }
        if (fetchCalls.length === 2) {
          return new Response('', { status: 302, headers: { location: 'https://8.8.8.8/back' } });
        }
        return new Response('ok');
      },
    },
  });

  await safeFetch('https://8.8.8.8/start', {
    headers: {
      Authorization: 'Bearer secret-token',
      'Proxy-Authorization': 'Basic proxy-secret',
      Cookie: 'session=secret-cookie',
      Cookie2: 'legacy=secret-cookie',
      'X-Trace-Id': 'trace-2',
    },
  });

  assert.deepEqual(fetchCalls.map(call => call.url), [
    'https://8.8.8.8/start',
    'https://1.1.1.1/away',
    'https://8.8.8.8/back',
  ]);
  assert.equal(fetchCalls[0].headers.get('authorization'), 'Bearer secret-token');
  for (const call of fetchCalls.slice(1)) {
    assert.equal(call.headers.get('authorization'), null);
    assert.equal(call.headers.get('proxy-authorization'), null);
    assert.equal(call.headers.get('cookie'), null);
    assert.equal(call.headers.get('cookie2'), null);
    assert.equal(call.headers.get('x-trace-id'), 'trace-2');
  }
});

test('safeFetch treats protocol and port changes as cross-origin redirects', async () => {
  delete process.env.ALLOW_LOCAL_NETWORK;
  const cases = [
    ['https://8.8.8.8/start', 'http://8.8.8.8/finish'],
    ['https://8.8.8.8/start', 'https://8.8.8.8:444/finish'],
  ];

  for (const [startUrl, redirectUrl] of cases) {
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
        fetch: async (url, init) => {
          fetchCalls.push({ url, headers: new Headers(init.headers) });
          return fetchCalls.length === 1
            ? new Response('', { status: 302, headers: { location: redirectUrl } })
            : new Response('ok');
        },
      },
    });

    await safeFetch(startUrl, { headers: { Authorization: 'Bearer secret-token' } });

    assert.equal(fetchCalls[1].headers.get('authorization'), null, redirectUrl);
    deleteIfCached('src/lib/ssrf-guard.ts');
  }
});

test('SSRF guard classifies local and special IPv4, IPv6, and mapped ranges consistently', async () => {
  const localUrls = [
    'http://127.0.0.1/service',
    'http://10.0.0.1/service',
    'http://172.31.255.255/service',
    'http://192.168.0.1/service',
    'http://100.64.0.1/service',
    'http://100.127.255.254/service',
    'http://[::1]/service',
    'http://[fc00::1]/service',
    'http://[fdff::1]/service',
    'http://[fec0::1]/service',
    'http://[::ffff:100.64.0.1]/service',
  ];
  const alwaysBlockedUrls = [
    'http://0.0.0.1/service',
    'http://169.254.169.254/service',
    'http://192.0.0.1/service',
    'http://192.0.2.1/service',
    'http://192.88.99.1/service',
    'http://198.18.0.1/service',
    'http://198.51.100.1/service',
    'http://203.0.113.1/service',
    'http://224.0.0.1/service',
    'http://240.0.0.1/service',
    'http://255.255.255.255/service',
    'http://[::]/service',
    'http://[100::1]/service',
    'http://[2001:2::1]/service',
    'http://[2001:db8::1]/service',
    'http://[3fff::1]/service',
    'http://[fe80::1]/service',
    'http://[ff02::1]/service',
    'http://[::ffff:192.0.2.1]/service',
  ];

  for (const allowLocal of [false, true]) {
    if (allowLocal) process.env.ALLOW_LOCAL_NETWORK = '1';
    else delete process.env.ALLOW_LOCAL_NETWORK;
    deleteIfCached('src/lib/ssrf-guard.ts');
    const { assertSafeUrl } = require('../src/lib/ssrf-guard.ts');

    for (const rawUrl of alwaysBlockedUrls) {
      await assert.rejects(() => assertSafeUrl(rawUrl), /SSRF 防护拒绝/, `${rawUrl} should always be rejected`);
    }
    for (const rawUrl of localUrls) {
      if (allowLocal) {
        await assert.doesNotReject(() => assertSafeUrl(rawUrl), rawUrl);
      } else {
        await assert.rejects(() => assertSafeUrl(rawUrl), /SSRF 防护拒绝/, rawUrl);
      }
    }
  }
});

test('SSRF guard does not reject public addresses adjacent to special ranges', async () => {
  delete process.env.ALLOW_LOCAL_NETWORK;
  const { assertSafeUrl } = require('../src/lib/ssrf-guard.ts');
  const publicUrls = [
    'http://100.63.255.255/service',
    'http://100.128.0.1/service',
    'http://192.0.0.9/service',
    'http://192.0.0.10/service',
    'http://192.0.1.1/service',
    'http://192.0.3.1/service',
    'http://198.17.255.255/service',
    'http://198.20.0.1/service',
    'http://223.255.255.254/service',
    'http://[2606:4700:4700::1111]/service',
  ];

  for (const rawUrl of publicUrls) {
    await assert.doesNotReject(() => assertSafeUrl(rawUrl), rawUrl);
  }
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
  let claude = '';
  try {
    claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const readmeZh = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const readmeEn = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const entrypoint = fs.readFileSync(path.join(root, 'docker-entrypoint.sh'), 'utf8');
  const docs = `${claude}\n${readmeZh}\n${readmeEn}`;

  assert.match(envExample, /TRUST_PROXY/);
  assert.match(envExample, /TRUST_PROXY_HOPS/);
  assert.match(envExample, /X-Forwarded-For|反向代理|reverse proxy/i);
  assert.match(envExample, /100\.64\.0\.0\/10|CGNAT|overlay/i);
  assert.match(docs, /TRUST_PROXY/);
  assert.match(docs, /TRUST_PROXY_HOPS/);
  assert.match(docs, /不得.*直连|must not be reachable directly|must not expose.*direct/i);
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
