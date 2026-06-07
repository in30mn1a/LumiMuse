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
  process.env.AUTH_SECRET = 'proxy-auth-test-secret';
  process.env.NODE_ENV = 'test';
  delete process.env.TRUST_PROXY;
}

function clearAuthEnv() {
  delete process.env.ACCESS_PASSWORD;
  process.env.AUTH_SECRET = 'proxy-auth-test-secret';
  process.env.NODE_ENV = 'test';
  delete process.env.TRUST_PROXY;
}

function deleteModuleCache(relativePath) {
  const resolved = require.resolve(path.join(root, relativePath));
  delete require.cache[resolved];
}

function resetAuthModules() {
  for (const relativePath of [
    'src/app/api/auth/route.ts',
    'src/proxy.ts',
    'src/lib/auth-token.ts',
    'src/lib/settings.ts',
  ]) {
    deleteModuleCache(relativePath);
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
    resetAuthModules();
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function makeSettingsMock(overrides = {}) {
  return {
    getAuthMinIat: () => 0,
    bumpAuthMinIat: () => 1,
    ...overrides,
  };
}

function loadProxy(settingsMock = makeSettingsMock()) {
  return requireFreshWithMocks('../src/proxy.ts', {
    './lib/settings': settingsMock,
  });
}

function loadAuthRoute(settingsMock = makeSettingsMock()) {
  return requireFreshWithMocks('../src/app/api/auth/route.ts', {
    '@/lib/settings': settingsMock,
  });
}

function authRequest(pathname, init = {}) {
  return new NextRequest(`http://test.local${pathname}`, init);
}

function jsonAuthRequest(method, body, headers = {}) {
  return authRequest('/api/auth', {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function setCookieHeader(response) {
  return response.headers.get('set-cookie') || '';
}

async function jsonPayload(response) {
  return response.json();
}

test.afterEach(() => {
  restoreEnv();
  resetAuthModules();
});

test('timingSafeEqualString returns false for different lengths, false for different content, and true for equal content', () => {
  resetAuthModules();
  const { timingSafeEqualString } = require('../src/lib/auth-token.ts');

  assert.equal(timingSafeEqualString('secret', 'secret-extra'), false);
  assert.equal(timingSafeEqualString('secret-a', 'secret-b'), false);
  assert.equal(timingSafeEqualString('same-secret', 'same-secret'), true);
});

test('proxy allows all requests when access password is not configured', async () => {
  clearAuthEnv();
  const { proxy } = loadProxy(makeSettingsMock({
    getAuthMinIat: () => {
      throw new Error('getAuthMinIat should not be called without access password');
    },
  }));

  const response = await proxy(authRequest('/api/messages'));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

test('proxy returns 401 for protected API requests without a cookie', async () => {
  setAuthEnv();
  const { proxy } = loadProxy();

  const response = await proxy(authRequest('/api/messages'));
  const payload = await jsonPayload(response);

  assert.equal(response.status, 401);
  assert.equal(payload.error, '未授权，请先登录');
});

test('proxy allows unauthenticated health checks when access password is configured', async () => {
  setAuthEnv();
  const { proxy } = loadProxy();

  const response = await proxy(authRequest('/api/health'));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

test('proxy protects health subpaths when access password is configured', async () => {
  setAuthEnv();
  const { proxy } = loadProxy();

  const response = await proxy(authRequest('/api/health/anything'));

  assert.equal(response.status, 401);
  const payload = await jsonPayload(response);
  assert.equal(payload.error, '未授权，请先登录');
});

test('proxy protects auth subpaths when access password is configured', async () => {
  setAuthEnv();
  const { proxy } = loadProxy();

  const response = await proxy(authRequest('/api/auth/anything'));

  assert.equal(response.status, 401);
  const payload = await jsonPayload(response);
  assert.equal(payload.error, '未授权，请先登录');
});

test('proxy allows protected API requests with a valid auth token', async () => {
  setAuthEnv();
  resetAuthModules();
  const { issueAuthToken, AUTH_COOKIE_NAME } = require('../src/lib/auth-token.ts');
  const token = await issueAuthToken();
  const { proxy } = loadProxy();

  const response = await proxy(authRequest('/api/messages', {
    headers: {
      cookie: `${AUTH_COOKIE_NAME}=${token}`,
    },
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

test('proxy rejects cross-site style API write requests with unsupported content type', async () => {
  setAuthEnv();
  const { proxy } = loadProxy();

  const response = await proxy(authRequest('/api/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'message=hi',
  }));
  const payload = await jsonPayload(response);

  assert.equal(response.status, 415);
  assert.equal(payload.error, '请求 Content-Type 不被允许');
});

test('/api/auth POST sets the expected auth cookie attributes on successful login', async () => {
  setAuthEnv();
  const route = loadAuthRoute();

  const response = await route.POST(jsonAuthRequest('POST', { password: 'correct-password' }));
  const payload = await jsonPayload(response);
  const cookie = setCookieHeader(response);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.match(cookie, /lumimuse_auth=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Max-Age=2592000/i);
  assert.match(cookie, /Path=\//i);
  assert.doesNotMatch(cookie, /Secure/i);
});

test('/api/auth DELETE without a valid cookie clears only the response cookie and does not bump min_iat', async () => {
  setAuthEnv();
  let bumpCalls = 0;
  const route = loadAuthRoute(makeSettingsMock({
    bumpAuthMinIat: () => {
      bumpCalls += 1;
      return 1;
    },
  }));

  const response = await route.DELETE(authRequest('/api/auth', { method: 'DELETE' }));
  const cookie = setCookieHeader(response);

  assert.equal(response.status, 200);
  assert.equal(bumpCalls, 0);
  assert.match(cookie, /lumimuse_auth=;/);
  assert.match(cookie, /Max-Age=0/i);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//i);
});

test('/api/auth DELETE with a valid cookie bumps min_iat and clears the response cookie', async () => {
  setAuthEnv();
  resetAuthModules();
  const { issueAuthToken, AUTH_COOKIE_NAME } = require('../src/lib/auth-token.ts');
  const token = await issueAuthToken();
  let bumpCalls = 0;
  const route = loadAuthRoute(makeSettingsMock({
    bumpAuthMinIat: () => {
      bumpCalls += 1;
      return 1;
    },
  }));

  const response = await route.DELETE(authRequest('/api/auth', {
    method: 'DELETE',
    headers: {
      cookie: `${AUTH_COOKIE_NAME}=${token}`,
    },
  }));
  const cookie = setCookieHeader(response);

  assert.equal(response.status, 200);
  assert.equal(bumpCalls, 1);
  assert.match(cookie, /lumimuse_auth=;/);
  assert.match(cookie, /Max-Age=0/i);
});

test('/api/auth POST does not trust X-Forwarded-For by default or share an unknown-IP bucket', async () => {
  setAuthEnv();
  const route = loadAuthRoute();
  let response = null;

  for (let i = 0; i < 11; i += 1) {
    response = await route.POST(jsonAuthRequest('POST', { password: 'wrong-password' }, {
      'x-forwarded-for': `203.0.113.${i}`,
    }));
  }

  assert.equal(response.status, 401);

  response = await route.POST(jsonAuthRequest('POST', { password: 'wrong-password' }));
  assert.equal(response.status, 401);
});

test('/api/auth POST rate limits the same forwarded IP when TRUST_PROXY is enabled', async () => {
  setAuthEnv();
  process.env.TRUST_PROXY = '1';
  const route = loadAuthRoute();
  let response = null;

  for (let i = 0; i < 11; i += 1) {
    response = await route.POST(jsonAuthRequest('POST', { password: 'wrong-password' }, {
      'x-forwarded-for': '203.0.113.10',
    }));
  }

  const payload = await jsonPayload(response);
  assert.equal(response.status, 429);
  assert.equal(payload.error, '尝试次数过多，请稍后再试');
});
