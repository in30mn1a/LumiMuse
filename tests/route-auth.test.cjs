const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
const originalEnv = {
  ACCESS_PASSWORD: process.env.ACCESS_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
  NODE_ENV: process.env.NODE_ENV,
  TRUST_PROXY: process.env.TRUST_PROXY,
  TRUST_PROXY_HOPS: process.env.TRUST_PROXY_HOPS,
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

function setAuthEnv() {
  process.env.ACCESS_PASSWORD = 'correct-password';
  process.env.AUTH_SECRET = 'route-auth-test-secret';
  process.env.NODE_ENV = 'test';
  delete process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY_HOPS;
}

function clearAuthEnv() {
  delete process.env.ACCESS_PASSWORD;
  process.env.AUTH_SECRET = 'route-auth-test-secret';
  process.env.NODE_ENV = 'test';
  delete process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY_HOPS;
}

function deleteIfCached(relativePath) {
  try {
    const resolved = require.resolve(path.join(root, relativePath));
    delete require.cache[resolved];
  } catch {
    // Optional module not present before the remediation is implemented.
  }
}

function resetModules(extra = []) {
  for (const relativePath of [
    'src/lib/auth-token.ts',
    'src/lib/route-auth.ts',
    'src/lib/settings.ts',
    'src/app/api/auth/route.ts',
    'src/app/api/providers/route.ts',
    'src/app/api/providers/activate/route.ts',
    'src/app/api/maintenance/route.ts',
    'src/app/api/import/route.ts',
    'src/app/api/settings/route.ts',
    ...extra,
  ]) {
    deleteIfCached(relativePath);
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
    resetModules([modulePath.replace('../', '')]);
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function getDbMock() {
  return {
    prepare(sql) {
      return {
        all() {
          if (sql.includes('SELECT * FROM api_providers')) return [];
          if (sql.includes('SELECT avatar_url FROM characters')) return [];
          return [];
        },
        get() {
          if (sql.includes('COUNT(*) as n')) return { n: 0 };
          return undefined;
        },
        run() {
          return { changes: 0 };
        },
      };
    },
    transaction(fn) {
      return fn;
    },
  };
}

function settingsMock(minIat) {
  return {
    getAuthMinIat: () => minIat,
    loadSettings: () => ({
      active_provider_id: '',
      api_key: '',
      image_gen: {},
      memory_engine: {},
    }),
  };
}

function makeRequest(pathname, token) {
  const headers = token ? { cookie: `lumimuse_auth=${token}` } : {};
  return new NextRequest(`http://test.local${pathname}`, { headers });
}

function jsonRequest(pathname, token, body, headers = {}) {
  return new NextRequest(`http://test.local${pathname}`, {
    method: 'POST',
    headers: {
      cookie: token ? `lumimuse_auth=${token}` : '',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function loadAuthRoute() {
  return requireFreshWithMocks('../src/app/api/auth/route.ts', {
    '@/lib/settings': {
      getAuthMinIat: () => 0,
      bumpAuthMinIat: () => 1,
    },
  });
}

function authMinIatDbMock() {
  const rows = new Map();
  return {
    prepare(sql) {
      if (sql.includes('SELECT value FROM settings WHERE key = ?')) {
        return {
          get(key) {
            const value = rows.get(key);
            return value === undefined ? undefined : { value };
          },
        };
      }
      if (sql.includes('INSERT INTO settings')) {
        return {
          run(key, value) {
            rows.set(key, value);
            return { changes: 1 };
          },
        };
      }
      throw new Error(`Unexpected SQL in auth min_iat test: ${sql}`);
    },
  };
}

async function issueToken() {
  resetModules();
  const { issueAuthToken } = require('../src/lib/auth-token.ts');
  return issueAuthToken();
}

test.afterEach(() => {
  restoreEnv();
  resetModules();
});

test('/api/auth POST rate limits direct bad password attempts without TRUST_PROXY', async () => {
  setAuthEnv();
  const route = loadAuthRoute();
  let response = null;

  for (let i = 0; i < 11; i += 1) {
    response = await route.POST(jsonRequest('/api/auth', '', { password: 'wrong-password' }));
  }

  const payload = await response.json();
  assert.equal(response.status, 429);
  assert.equal(payload.error, '尝试次数过多，请稍后再试');
});

test('/api/auth POST rate limits untrusted x-forwarded-for with shared bucket', async () => {
  setAuthEnv();
  const route = loadAuthRoute();
  let response = null;

  for (let i = 0; i < 11; i += 1) {
    response = await route.POST(jsonRequest('/api/auth', '', { password: 'wrong-password' }, {
      'x-forwarded-for': `203.0.113.${i}`,
    }));
  }

  const payload = await response.json();
  assert.equal(response.status, 429);
  assert.equal(payload.error, '尝试次数过多，请稍后再试');
});

test('/api/auth POST selects the client from the right when TRUST_PROXY is enabled', async () => {
  setAuthEnv();
  process.env.TRUST_PROXY = '1';
  const route = loadAuthRoute();
  let response = null;

  for (let i = 0; i < 10; i += 1) {
    response = await route.POST(jsonRequest('/api/auth', '', { password: 'wrong-password' }, {
      'x-forwarded-for': `203.0.113.${i}, 198.51.100.20`,
    }));
    assert.equal(response.status, 401);
  }

  response = await route.POST(jsonRequest('/api/auth', '', { password: 'wrong-password' }, {
    'x-forwarded-for': '203.0.113.250, 198.51.100.20',
  }));

  assert.equal(response.status, 429);
});

test('/api/auth POST supports multiple trusted proxy hops', async () => {
  setAuthEnv();
  process.env.TRUST_PROXY = '1';
  process.env.TRUST_PROXY_HOPS = '2';
  const route = loadAuthRoute();
  let response = null;

  for (let i = 0; i < 11; i += 1) {
    response = await route.POST(jsonRequest('/api/auth', '', { password: 'wrong-password' }, {
      'x-forwarded-for': `192.0.2.${i}, 203.0.113.30, 198.51.100.40`,
    }));
  }

  assert.equal(response.status, 429);
});

test('/api/auth POST uses the shared untrusted bucket for short trusted proxy chains', async () => {
  setAuthEnv();
  process.env.TRUST_PROXY = '1';
  process.env.TRUST_PROXY_HOPS = '2';
  const route = loadAuthRoute();
  let response = null;

  for (let i = 0; i < 11; i += 1) {
    response = await route.POST(jsonRequest('/api/auth', '', { password: 'wrong-password' }, {
      'x-forwarded-for': `203.0.113.${i}`,
    }));
  }

  assert.equal(response.status, 429);
});

test('/api/auth POST uses the shared untrusted bucket for malformed XFF chains', async () => {
  setAuthEnv();
  process.env.TRUST_PROXY = '1';
  const route = loadAuthRoute();
  let response = null;

  for (let i = 0; i < 11; i += 1) {
    response = await route.POST(jsonRequest('/api/auth', '', { password: 'wrong-password' }, {
      'x-forwarded-for': `203.0.113.${i}, invalid-${i}`,
    }));
  }

  assert.equal(response.status, 429);
});

test('/api/auth POST uses the shared untrusted bucket for invalid TRUST_PROXY_HOPS', async () => {
  setAuthEnv();
  process.env.TRUST_PROXY = '1';
  process.env.TRUST_PROXY_HOPS = '0';
  const route = loadAuthRoute();
  let response = null;

  for (let i = 0; i < 11; i += 1) {
    response = await route.POST(jsonRequest('/api/auth', '', { password: 'wrong-password' }, {
      'x-forwarded-for': `203.0.113.${i}`,
    }));
  }

  assert.equal(response.status, 429);
});

test('/api/auth POST allows local mode when ACCESS_PASSWORD is unset', async () => {
  clearAuthEnv();
  const route = loadAuthRoute();
  let response = null;

  for (let i = 0; i < 11; i += 1) {
    response = await route.POST(jsonRequest('/api/auth', '', { password: 'wrong-password' }));
  }

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
});

test('bumpAuthMinIat immediately rejects tokens issued in the same millisecond', async () => {
  setAuthEnv();
  const realDateNow = Date.now;
  Date.now = () => 1_717_171_717_000;

  try {
    const settings = requireFreshWithMocks('../src/lib/settings.ts', {
      '@/lib/db': { getDb: authMinIatDbMock },
    });
    const { issueAuthToken, verifyAuthToken } = require('../src/lib/auth-token.ts');
    const oldToken = await issueAuthToken();

    const minIat = settings.bumpAuthMinIat();

    assert.equal(minIat, 1_717_171_717_001);
    assert.equal(await verifyAuthToken(oldToken, { minIat }), false);
  } finally {
    Date.now = realDateNow;
  }
});

test('sensitive route-level auth rejects tokens issued before current min_iat', async () => {
  setAuthEnv();
  const oldToken = await issueToken();
  const minIat = Date.now() + 1000;
  const mocks = {
    '@/lib/db': { getDb: getDbMock },
    '@/lib/settings': settingsMock(minIat),
    'fs': { existsSync: () => true },
    'fs/promises': { readdir: async () => [] },
  };

  const providers = requireFreshWithMocks('../src/app/api/providers/route.ts', mocks);
  const activate = requireFreshWithMocks('../src/app/api/providers/activate/route.ts', mocks);
  const maintenance = requireFreshWithMocks('../src/app/api/maintenance/route.ts', mocks);
  const importRoute = requireFreshWithMocks('../src/app/api/import/route.ts', mocks);
  const settings = requireFreshWithMocks('../src/app/api/settings/route.ts', mocks);

  const cases = [
    ['providers GET', () => providers.GET(makeRequest('/api/providers', oldToken))],
    ['providers activate POST', () => activate.POST(jsonRequest('/api/providers/activate', oldToken, {
      id: '11111111-1111-4111-8111-111111111111',
    }))],
    ['maintenance GET', () => maintenance.GET(makeRequest('/api/maintenance', oldToken))],
    ['import POST', () => importRoute.POST(jsonRequest('/api/import', oldToken, { version: 2 }))],
    ['settings GET', () => settings.GET(makeRequest('/api/settings', oldToken))],
  ];

  for (const [name, call] of cases) {
    const response = await call();
    assert.equal(response.status, 401, `${name} should reject old tokens`);
  }
});

test('sensitive route-level auth allows local mode when ACCESS_PASSWORD is unset', async () => {
  clearAuthEnv();
  const mocks = {
    '@/lib/db': { getDb: getDbMock },
    '@/lib/settings': {
      ...settingsMock(() => {
        throw new Error('getAuthMinIat should not be called in local mode');
      }),
      getAuthMinIat: () => {
        throw new Error('getAuthMinIat should not be called in local mode');
      },
    },
  };

  const providers = requireFreshWithMocks('../src/app/api/providers/route.ts', mocks);
  const settings = requireFreshWithMocks('../src/app/api/settings/route.ts', mocks);

  const providersResponse = await providers.GET(makeRequest('/api/providers'));
  const settingsResponse = await settings.GET(makeRequest('/api/settings'));

  assert.equal(providersResponse.status, 200);
  assert.equal(settingsResponse.status, 200);
});
