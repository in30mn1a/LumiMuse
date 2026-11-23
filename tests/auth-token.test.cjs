const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/register-ts-loader.cjs').registerTsLoader();

const SECRET = 'auth-token-test-secret-0123456789abcdef';
const originalEnv = { AUTH_SECRET: process.env.AUTH_SECRET, ACCESS_PASSWORD: process.env.ACCESS_PASSWORD };
process.env.AUTH_SECRET = SECRET;
process.env.ACCESS_PASSWORD = 'auth-token-test-password';

const { issueAuthToken, verifyAuthToken, TOKEN_TTL_MS } = require('../src/lib/auth-token.ts');

test.after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const base64Url = bytes => Buffer.from(bytes).toString('base64url');

/** 按 auth-token.ts 的格式自签任意 payload，用来覆盖签名正确但内容不合法的分支。 */
async function signPayload(payload, secret = SECRET) {
  const payloadB64 = base64Url(new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${base64Url(new Uint8Array(sig))}`;
}

function withNow(t, now) {
  const realNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
}

test('a freshly issued token verifies, and so does one signed by the test helper', async () => {
  assert.equal(await verifyAuthToken(await issueAuthToken()), true);
  assert.equal(await verifyAuthToken(await signPayload({ v: 1, iat: Date.now(), nonce: 'n' })), true);
});

test('a token whose payload was edited after signing is rejected', async () => {
  const [, sig] = (await issueAuthToken()).split('.');
  const forgedPayload = base64Url(new TextEncoder().encode(JSON.stringify({ v: 1, iat: Date.now() + 60_000, nonce: 'x' })));
  assert.equal(await verifyAuthToken(`${forgedPayload}.${sig}`), false);
});

test('a token with an altered signature is rejected', async () => {
  const [payload, sig] = (await issueAuthToken()).split('.');
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  assert.equal(await verifyAuthToken(`${payload}.${flipped}`), false);
});

test('a token signed with another secret is rejected', async () => {
  const token = await signPayload({ v: 1, iat: Date.now(), nonce: 'n' }, 'some-other-secret');
  assert.equal(await verifyAuthToken(token), false);
});

test('a token is accepted up to its TTL and rejected one millisecond after', async t => {
  const issuedAt = 1_800_000_000_000;
  const token = await signPayload({ v: 1, iat: issuedAt, nonce: 'n' });
  withNow(t, issuedAt + TOKEN_TTL_MS);
  assert.equal(await verifyAuthToken(token), true);
  Date.now = () => issuedAt + TOKEN_TTL_MS + 1;
  assert.equal(await verifyAuthToken(token), false);
});

test('a token issued in the future is rejected', async () => {
  const token = await signPayload({ v: 1, iat: Date.now() + 60_000, nonce: 'n' });
  assert.equal(await verifyAuthToken(token), false);
});

test('correctly signed payloads with the wrong version, a non-numeric iat or invalid JSON are rejected', async () => {
  const now = Date.now();
  assert.equal(await verifyAuthToken(await signPayload({ v: 2, iat: now, nonce: 'n' })), false);
  assert.equal(await verifyAuthToken(await signPayload({ v: 1, iat: String(now), nonce: 'n' })), false);
  assert.equal(await verifyAuthToken(await signPayload('not json')), false);
});

test('missing or malformed tokens are rejected without throwing', async () => {
  const valid = await issueAuthToken();
  for (const token of [undefined, null, '', 'no-dot', 'a.b.c', `${valid}.extra`, '%%%.%%%', '.']) {
    assert.equal(await verifyAuthToken(token), false, `token ${JSON.stringify(token)} must be rejected`);
  }
});
