const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

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

const {
  HttpResponseError,
  expectOkResponse,
  parseJsonArrayResponse,
  parseJsonResponse,
} = require(path.resolve(__dirname, '../src/lib/http.ts'));

test('parseJsonResponse returns valid JSON data', async () => {
  const data = await parseJsonResponse(new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  }));

  assert.deepEqual(data, { ok: true });
});

test('parseJsonResponse rejects a successful non-JSON response with typed status and data', async () => {
  await assert.rejects(
    () => parseJsonResponse(new Response('<html>not json</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })),
    error => {
      assert.ok(error instanceof HttpResponseError);
      assert.equal(error.message, 'Invalid JSON response (HTTP 200)');
      assert.equal(error.status, 200);
      assert.equal(error.data, null);
      return true;
    },
  );
});

for (const { status, body, message } of [
  { status: 401, body: { error: 'Unauthorized' }, message: 'Unauthorized' },
  { status: 500, body: { message: 'Server failed', code: 'E_TEST' }, message: 'Server failed' },
]) {
  test(`parseJsonResponse preserves status and JSON data for HTTP ${status}`, async () => {
    await assert.rejects(
      () => parseJsonResponse(new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })),
      error => {
        assert.ok(error instanceof HttpResponseError);
        assert.equal(error.message, message);
        assert.equal(error.status, status);
        assert.deepEqual(error.data, body);
        return true;
      },
    );
  });
}

test('parseJsonArrayResponse rejects a 200 JSON object instead of treating it as an array', async () => {
  const body = { error: 'unexpected envelope' };

  await assert.rejects(
    () => parseJsonArrayResponse(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })),
    error => {
      assert.ok(error instanceof HttpResponseError);
      assert.equal(error.message, 'Expected JSON array (HTTP 200)');
      assert.equal(error.status, 200);
      assert.deepEqual(error.data, body);
      return true;
    },
  );
});

test('parseJsonArrayResponse returns an array payload', async () => {
  const body = [{ id: 1 }, { id: 2 }];
  const data = await parseJsonArrayResponse(new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  }));

  assert.deepEqual(data, body);
});

test('expectOkResponse still accepts an empty successful response', async () => {
  await expectOkResponse(new Response(null, { status: 204 }));
});
