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
    for (const resetPath of [
      modulePath,
      '../src/lib/schemas.ts',
      '../src/types/index.ts',
    ]) {
      const resolved = require.resolve(resetPath);
      delete require.cache[resolved];
    }
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

function jsonRequest(body) {
  return {
    signal: new AbortController().signal,
    async json() {
      return body;
    },
  };
}

function createImageGenHarness({ imageGenSettings, safeFetchImpl }) {
  const writes = [];
  const mkdirs = [];
  const safeFetchCalls = [];
  const route = requireFreshWithMocks('../src/app/api/image-gen/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/settings': {
      loadSettings: () => ({
        image_gen: imageGenSettings,
      }),
    },
    '@/lib/ssrf-guard': {
      safeFetch: async (url, init) => {
        safeFetchCalls.push({ url, init });
        return safeFetchImpl(url, init);
      },
    },
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

  return { route, writes, mkdirs, safeFetchCalls };
}

function createInvalidBodyHarness() {
  const route = requireFreshWithMocks('../src/app/api/image-gen/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/settings': {
      loadSettings: () => {
        throw new Error('loadSettings should not be called for invalid request body');
      },
    },
    '@/lib/ssrf-guard': {
      safeFetch: () => {
        throw new Error('safeFetch should not be called for invalid request body');
      },
    },
    'fs/promises': {
      mkdir: () => {
        throw new Error('mkdir should not be called for invalid request body');
      },
      writeFile: () => {
        throw new Error('writeFile should not be called for invalid request body');
      },
    },
  });

  return { route };
}

function customSettings(extra = {}) {
  return {
    enabled: true,
    engine: 'custom',
    custom_url: 'https://images.example/v1/images',
    custom_model: 'img-model',
    custom_api_key: 'custom-secret',
    quality_tags: '',
    ...extra,
  };
}

function naiSettings(extra = {}) {
  return {
    enabled: true,
    engine: 'nai',
    nai_api_key: 'nai-secret',
    nai_model: 'nai-diffusion-3',
    quality_tags: '',
    ...extra,
  };
}

function comfySettings(extra = {}) {
  return {
    enabled: true,
    engine: 'comfyui',
    comfyui_url: 'https://comfy.example',
    sd_negative_prompt: '',
    quality_tags: '',
    sd_steps: 20,
    sd_cfg_scale: 7,
    sd_width: 512,
    sd_height: 768,
    sd_model: 'model.safetensors',
    ...extra,
  };
}

function pngBytes() {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);
}

function streamResponse(chunks, { contentType = 'image/png', contentLength = null, onCancel } = {}) {
  let index = 0;
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() {
      if (onCancel) onCancel();
    },
  });
  const headers = new Headers({ 'content-type': contentType });
  if (contentLength !== null) headers.set('content-length', String(contentLength));
  const response = new Response(body, { status: 200, headers });
  return {
    response,
    getPulls: () => pulls,
  };
}

async function withSilencedConsoleError(callback) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.error = originalError;
  }
}

test('/api/image-gen rejects disabled saved settings before override can re-enable or call upstream', async () => {
  const harness = createImageGenHarness({
    imageGenSettings: customSettings({ enabled: false }),
    safeFetchImpl: () => {
      throw new Error('safeFetch should not be called when saved image_gen is disabled');
    },
  });

  const response = await harness.route.POST(jsonRequest({
    prompt: 'cat',
    override: {
      enabled: true,
      engine: 'custom',
      custom_url: 'https://attacker.example/v1/images',
      custom_api_key: 'attacker-key',
    },
  }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, '生图功能未启用，请先在设置中开启');
  assert.deepEqual(harness.safeFetchCalls, []);
  assert.deepEqual(harness.writes, []);
});

test('/api/image-gen rejects non-object request bodies before loading settings', async () => {
  const { route } = createInvalidBodyHarness();

  const response = await route.POST(jsonRequest([]));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, 'Invalid request body');
});

test('/api/image-gen rejects unsafe override configuration fields', async () => {
  const harness = createImageGenHarness({
    imageGenSettings: customSettings(),
    safeFetchImpl: () => {
      throw new Error('safeFetch should not be called for invalid override');
    },
  });

  const response = await harness.route.POST(jsonRequest({
    prompt: 'cat',
    override: {
      api_base: 'https://attacker.example',
      nai_api_key: 'attacker-key',
      custom_url: 'https://attacker.example/v1/images',
    },
  }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, 'Invalid request body');
  assert.deepEqual(harness.safeFetchCalls, []);
  assert.deepEqual(harness.writes, []);
});

test('/api/image-gen stops no-Content-Length remote image streams after MAX_IMAGE_SIZE is exceeded', async () => {
  const tenMb = new Uint8Array(10 * 1024 * 1024);
  let imageStreamCancelled = false;
  const imageStream = streamResponse(
    [tenMb, tenMb, tenMb, tenMb],
    { onCancel: () => { imageStreamCancelled = true; } },
  );
  const harness = createImageGenHarness({
    imageGenSettings: customSettings(),
    safeFetchImpl: async url => {
      if (url === 'https://images.example/v1/images') {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/huge.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://cdn.example/huge.png') {
        return imageStream.response;
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  const response = await withSilencedConsoleError(() => harness.route.POST(jsonRequest({ prompt: 'cat' })));
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error, /响应体过大/);
  assert.ok(imageStream.getPulls() < 5);
  assert.equal(imageStreamCancelled, true);
  assert.deepEqual(harness.writes, []);
});

test('/api/image-gen stops no-Content-Length NovelAI responses after MAX_IMAGE_SIZE is exceeded', async () => {
  const tenMb = new Uint8Array(10 * 1024 * 1024);
  let naiStreamCancelled = false;
  const naiStream = streamResponse(
    [tenMb, tenMb, tenMb, tenMb],
    {
      contentType: 'application/zip',
      onCancel: () => { naiStreamCancelled = true; },
    },
  );
  const harness = createImageGenHarness({
    imageGenSettings: naiSettings(),
    safeFetchImpl: async url => {
      assert.equal(url, 'https://image.novelai.net/ai/generate-image');
      return naiStream.response;
    },
  });

  const response = await withSilencedConsoleError(() => harness.route.POST(jsonRequest({ prompt: 'cat' })));
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error, /NovelAI 响应过大/);
  assert.ok(naiStream.getPulls() < 5);
  assert.equal(naiStreamCancelled, true);
  assert.deepEqual(harness.writes, []);
});

test('/api/image-gen still persists normal small remote images', async () => {
  const smallImage = streamResponse([pngBytes()]);
  const harness = createImageGenHarness({
    imageGenSettings: customSettings(),
    safeFetchImpl: async url => {
      if (url === 'https://images.example/v1/images') {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/small.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://cdn.example/small.png') {
        return smallImage.response;
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  const response = await harness.route.POST(jsonRequest({ prompt: 'cat' }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.url, '/api/files/generated/11111111-1111-4111-8111-111111111111.png');
  assert.equal(smallImage.getPulls(), 2);
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].size, pngBytes().byteLength);
});

test('/api/image-gen writes ComfyUI prompt placeholders through parsed JSON values', async () => {
  let queuedWorkflow = null;
  const smallImage = streamResponse([pngBytes()]);
  const harness = createImageGenHarness({
    imageGenSettings: comfySettings({
      comfyui_workflow: JSON.stringify({
        '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{positive_prompt}}' } },
        '7': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative_prompt}}' } },
      }),
    }),
    safeFetchImpl: async (url, init) => {
      if (url === 'https://comfy.example/prompt') {
        queuedWorkflow = JSON.parse(init.body).prompt;
        return new Response(JSON.stringify({ prompt_id: 'prompt-a' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://comfy.example/history/prompt-a') {
        return new Response(JSON.stringify({
          'prompt-a': {
            outputs: {
              '9': {
                images: [{ filename: 'image.png', subfolder: '', type: 'output' }],
              },
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://comfy.example/view?filename=image.png&subfolder=&type=output') {
        return smallImage.response;
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  const response = await harness.route.POST(jsonRequest({
    prompt: 'line one\nline two \\ slash "quote"',
    negative_prompt: 'bad\nline \\ slash "quote"',
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.url, '/api/files/generated/11111111-1111-4111-8111-111111111111.png');
  assert.equal(queuedWorkflow['6'].inputs.text, 'line one\nline two \\ slash "quote"');
  assert.equal(queuedWorkflow['7'].inputs.text, 'bad\nline \\ slash "quote"');
});
