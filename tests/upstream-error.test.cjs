const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { UpstreamApiError, classifyLlmError } = require('../src/lib/upstream-error.ts');
const { publicErrorMessage } = require('../src/lib/public-error.ts');
const { structuredLog } = require('../src/lib/structured-log.ts');

const BODY_MARKER = 'BODY-MARKER-7f3a';

function fetchFailed(code) {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return new TypeError('fetch failed', { cause });
}

function captureError(run) {
  const lines = [];
  const original = console.error;
  console.error = line => lines.push(line);
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
}

const cases = [
  ['401', new UpstreamApiError(401, `API error 401: invalid key ${BODY_MARKER}`), 'auth', 401],
  ['403', new UpstreamApiError(403, `API error 403: forbidden ${BODY_MARKER}`), 'auth', 403],
  ['429', new UpstreamApiError(429, `API error 429: slow down ${BODY_MARKER}`), 'rate_limit', 429],
  ['500', new UpstreamApiError(500, `API error 500: boom ${BODY_MARKER}`), 'upstream_server', 500],
  ['400', new UpstreamApiError(400, `API error 400: bad body ${BODY_MARKER}`), 'upstream_client', 400],
  ['network', fetchFailed('ECONNRESET'), 'network', undefined],
  ['bare fetch failed', new TypeError('fetch failed'), 'network', undefined],
  ['timeout', new DOMException('The operation timed out', 'TimeoutError'), 'timeout', undefined],
  ['socket timeout', fetchFailed('UND_ERR_HEADERS_TIMEOUT'), 'timeout', undefined],
];

for (const [label, error, category, httpStatus] of cases) {
  test(`classifies ${label}`, () => {
    const result = classifyLlmError(error);
    assert.equal(result.category, category);
    assert.equal(result.httpStatus, httpStatus);
  });
}

test('categories that diagnosis must tell apart stay distinct', () => {
  const picked = [
    new UpstreamApiError(401, 'a'),
    new UpstreamApiError(429, 'b'),
    new UpstreamApiError(500, 'c'),
    fetchFailed('ECONNRESET'),
    new DOMException('timed out', 'TimeoutError'),
  ].map(error => classifyLlmError(error));
  assert.equal(new Set(picked.map(item => item.category)).size, 5);
  assert.deepEqual(picked.slice(0, 3).map(item => item.httpStatus), [401, 429, 500]);
});

test('errors that are not LLM failures stay unknown', () => {
  const sqlite = Object.assign(new Error('database is locked'), { name: 'SqliteError', code: 'SQLITE_BUSY' });
  for (const error of [sqlite, new Error('Conversation not found'), 'plain string', undefined]) {
    assert.deepEqual(classifyLlmError(error), { category: 'unknown' });
  }
});

test('publicErrorMessage output is unchanged for classified errors', () => {
  const message = 'API error 401: invalid key';
  assert.equal(publicErrorMessage(new UpstreamApiError(401, message), 'fallback'), message);
  assert.equal(publicErrorMessage(new TypeError('fetch failed'), 'fallback'), 'fetch failed');
  assert.equal(
    publicErrorMessage(new DOMException('The operation timed out', 'TimeoutError'), 'fallback'),
    'The operation timed out',
  );
});

test('structuredLog adds category and status without leaking the upstream body', () => {
  for (const [, error, category, httpStatus] of cases) {
    const lines = captureError(() => structuredLog('error', 'test.failed', {}, error));
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.errorCategory, category);
    assert.equal(entry.httpStatus, httpStatus);
    assert.doesNotMatch(lines[0], new RegExp(BODY_MARKER));
  }
});

test('structuredLog keeps a status the caller set and adds nothing without an error', () => {
  const [withStatus] = captureError(() => (
    structuredLog('error', 'test.failed', { httpStatus: 502 }, new Error('x'))
  ));
  assert.equal(JSON.parse(withStatus).httpStatus, 502);

  const [withoutError] = captureError(() => structuredLog('error', 'test.failed', { taskId: 't' }));
  const entry = JSON.parse(withoutError);
  assert.equal(Object.hasOwn(entry, 'errorCategory'), false);
  assert.equal(Object.hasOwn(entry, 'httpStatus'), false);
});

test('request model metadata preserves error identity, classification and public text without enumerable payload', () => {
  const { withLlmRequestModel, getLlmRequestModel } = require('../src/lib/upstream-error.ts');
  for (const error of [new UpstreamApiError(429, 'limited'), new TypeError('fetch failed')]) {
    const classification = classifyLlmError(error);
    const publicText = publicErrorMessage(error, 'fallback');
    const serialized = JSON.stringify(error);
    assert.equal(withLlmRequestModel(error, 'actual-model'), error);
    assert.equal(getLlmRequestModel(error), 'actual-model');
    assert.deepEqual(classifyLlmError(error), classification);
    assert.equal(publicErrorMessage(error, 'fallback'), publicText);
    assert.equal(JSON.stringify(error), serialized);
  }
  assert.equal(getLlmRequestModel(withLlmRequestModel(new Error('unrelated'), undefined)), undefined);
});
