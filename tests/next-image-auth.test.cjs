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

function deleteModuleCache(relativePath) {
  try {
    const resolved = require.resolve(path.join(root, relativePath));
    delete require.cache[resolved];
  } catch {
    // Ignore optional modules in source-level contract tests.
  }
}

function resetAuthModules() {
  for (const relativePath of [
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

function loadProxy() {
  return requireFreshWithMocks('../src/proxy.ts', {
    './lib/settings': {
      getAuthMinIat: () => 0,
      bumpAuthMinIat: () => 1,
    },
  });
}

function authRequest(pathname, init = {}) {
  return new NextRequest(`http://test.local${pathname}`, init);
}

test.afterEach(() => {
  restoreEnv();
  resetAuthModules();
  deleteModuleCache('next.config.ts');
});

// ── F01：/_next/image 不得绕过 proxy 鉴权 ─────────────────────

test('proxy matcher does not exclude _next/image from auth coverage', () => {
  const source = fs.readFileSync(path.join(root, 'src/proxy.ts'), 'utf8');
  const matcherMatch = source.match(/'\/\(\(\?![^']*\)\.\*\)'/);
  assert.ok(matcherMatch, 'matcher 字符串应存在');
  assert.doesNotMatch(matcherMatch[0], /_next\/image/);
});

test('proxy source does not allowlist the whole /_next/ prefix before auth', () => {
  // matcher 收紧后，若 handler 仍按 /_next/ 前缀放行，修复会被静默抵消
  const source = fs.readFileSync(path.join(root, 'src/proxy.ts'), 'utf8');
  assert.doesNotMatch(source, /startsWith\('\/_next\/'\)/);
});

test('proxy blocks unauthenticated /_next/image requests when access password is configured', async () => {
  process.env.ACCESS_PASSWORD = 'correct-password';
  process.env.AUTH_SECRET = 'next-image-auth-test-secret';
  process.env.NODE_ENV = 'test';
  delete process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY_HOPS;
  const { proxy } = loadProxy();

  const response = await proxy(authRequest('/_next/image'));
  // 非页面路径未认证时的行为与其它非 API 路径一致：不 401 也绝不放行，
  // 而是重定向到登录页（放行会返回 x-middleware-next: 1）
  assert.equal(response.status, 307);
  assert.ok(response.headers.get('location')?.startsWith('http://test.local/login'));
  assert.notEqual(response.headers.get('x-middleware-next'), '1');
});

test('proxy still serves _next/static assets without authentication', async () => {
  process.env.ACCESS_PASSWORD = 'correct-password';
  process.env.AUTH_SECRET = 'next-image-auth-test-secret';
  process.env.NODE_ENV = 'test';
  delete process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY_HOPS;
  const { proxy } = loadProxy();

  const response = await proxy(authRequest('/_next/static/chunks/main.js'));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

test('proxy allows /_next/image requests carrying a valid auth token', async () => {
  process.env.ACCESS_PASSWORD = 'correct-password';
  process.env.AUTH_SECRET = 'next-image-auth-test-secret';
  process.env.NODE_ENV = 'test';
  delete process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY_HOPS;
  resetAuthModules();
  const { issueAuthToken, AUTH_COOKIE_NAME } = require('../src/lib/auth-token.ts');
  const token = await issueAuthToken();
  const { proxy } = loadProxy();

  const response = await proxy(authRequest('/_next/image', {
    headers: {
      cookie: `${AUTH_COOKIE_NAME}=${token}`,
    },
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

// ── F02：生产 CSP connect-src 收窄 ────────────────────────────

test('production CSP connect-src does not allow bare https: or wss: wildcards', async () => {
  process.env.NODE_ENV = 'production';
  deleteModuleCache('next.config.ts');
  const config = require('../next.config.ts').default;
  const headers = await config.headers();
  const csp = headers[0].headers.find(header => header.key === 'Content-Security-Policy').value;
  const connectSrc = csp.split(';').map(part => part.trim()).find(part => part.startsWith('connect-src '));

  assert.ok(connectSrc, 'connect-src directive should exist');
  // 浏览器端不出站：上游调用全在服务端 API route，生产只允许同源
  assert.doesNotMatch(connectSrc, /(?:^|\s)https:(?:\s|$)/);
  assert.doesNotMatch(connectSrc, /(?:^|\s)wss:(?:\s|$)/);
  assert.match(connectSrc, /'self'/);
});
