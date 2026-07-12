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

function jsonRequest(body, signal = new AbortController().signal) {
  return {
    signal,
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

function sdSettings(extra = {}) {
  return {
    enabled: true,
    engine: 'sd',
    sd_url: 'https://sd.example',
    quality_tags: '',
    sd_negative_prompt: '',
    sd_steps: 20,
    sd_cfg_scale: 7,
    sd_width: 512,
    sd_height: 768,
    sd_sampler: 'Euler',
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

async function withCapturedConsoleError(callback) {
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => {
    calls.push(args.map(arg => arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)).join(' '));
  };
  try {
    return { result: await callback(), calls };
  } finally {
    console.error = originalError;
  }
}

async function withImmediateComfyPollDelay(callback) {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (handler, delay, ...args) => (
    originalSetTimeout(handler, delay === 2000 ? 0 : delay, ...args)
  );
  try {
    return await callback();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

function rejectWhenAborted(signal, label) {
  if (!signal) {
    return Promise.reject(new Error(`${label} signal missing`));
  }
  return new Promise((resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error(`${label} aborted`);
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

for (const scenario of [
  {
    name: 'SD WebUI',
    settings: sdSettings(),
    expectedUrl: 'https://sd.example/sdapi/v1/txt2img',
    expectedError: 'SD WebUI 请求失败（HTTP 502）',
  },
  {
    name: 'NovelAI',
    settings: naiSettings(),
    expectedUrl: 'https://image.novelai.net/ai/generate-image',
    expectedError: 'NovelAI 请求失败（HTTP 502）',
  },
  {
    name: 'ComfyUI',
    settings: comfySettings(),
    expectedUrl: 'https://comfy.example/prompt',
    expectedError: 'ComfyUI 请求失败（HTTP 502）',
  },
  {
    name: '自定义 API',
    settings: customSettings(),
    expectedUrl: 'https://images.example/v1/images',
    expectedError: '自定义 API 请求失败（HTTP 502）',
  },
]) {
  test(`/api/image-gen redacts ${scenario.name} upstream error bodies from responses and console output`, async () => {
    const upstreamBody = 'debug Bearer sk-upstream-secret http://10.0.0.8/internal';
    const harness = createImageGenHarness({
      imageGenSettings: scenario.settings,
      safeFetchImpl: async url => {
        assert.equal(url, scenario.expectedUrl);
        return new Response(upstreamBody, { status: 502 });
      },
    });

    const { result: response, calls } = await withCapturedConsoleError(
      () => harness.route.POST(jsonRequest({ prompt: 'cat' })),
    );
    const body = await response.json();
    const observableOutput = `${JSON.stringify(body)}\n${calls.join('\n')}`;

    assert.equal(response.status, 500);
    assert.equal(body.error, scenario.expectedError);
    assert.doesNotMatch(observableOutput, /sk-upstream-secret/);
    assert.doesNotMatch(observableOutput, /Bearer/);
    assert.doesNotMatch(observableOutput, /10\.0\.0\.8/);
    assert.doesNotMatch(observableOutput, /\/internal/);
  });
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

test('/api/image-gen sends the exact SD WebUI txt2img payload with a composed signal', async () => {
  let capturedInit;
  const harness = createImageGenHarness({
    imageGenSettings: sdSettings({
      quality_tags: 'masterpiece, best quality',
      sd_negative_prompt: 'saved negative',
      sd_steps: 28,
      sd_cfg_scale: 6.5,
      sd_width: 640,
      sd_height: 960,
      sd_sampler: 'DPM++ 2M',
      generate_timeout_ms: 5000,
    }),
    safeFetchImpl: async (url, init) => {
      assert.equal(url, 'https://sd.example/sdapi/v1/txt2img');
      capturedInit = init;
      return new Response(JSON.stringify({
        images: [Buffer.from(pngBytes()).toString('base64')],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const response = await harness.route.POST(jsonRequest({
    prompt: '1girl, rainy library',
    negative_prompt: 'request negative',
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.url, '/api/files/generated/11111111-1111-4111-8111-111111111111.png');
  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.headers['Content-Type'], 'application/json');
  assert.ok(capturedInit.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(capturedInit.body), {
    prompt: 'masterpiece, best quality, 1girl, rainy library',
    negative_prompt: 'request negative',
    steps: 28,
    cfg_scale: 6.5,
    width: 640,
    height: 960,
    sampler_name: 'DPM++ 2M',
    batch_size: 1,
    n_iter: 1,
  });
  assert.equal(harness.writes.length, 1);
});

test('/api/image-gen aborts a stalled SD WebUI request at generate_timeout_ms', async () => {
  let upstreamSignal;
  const harness = createImageGenHarness({
    imageGenSettings: sdSettings({ generate_timeout_ms: 40 }),
    safeFetchImpl: async (_url, init) => {
      upstreamSignal = init.signal;
      return rejectWhenAborted(init.signal, 'SD WebUI');
    },
  });

  const response = await withSilencedConsoleError(
    () => harness.route.POST(jsonRequest({ prompt: 'stalled sd request' })),
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error, /SD WebUI 出图超时或已取消/);
  assert.equal(upstreamSignal.aborted, true);
  assert.deepEqual(harness.writes, []);
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

test('/api/image-gen applies generate_timeout_ms to NovelAI through an abort signal', async () => {
  const clientController = new AbortController();
  let upstreamSignal = null;
  const harness = createImageGenHarness({
    imageGenSettings: naiSettings({ generate_timeout_ms: 40 }),
    safeFetchImpl: async (url, init) => {
      assert.equal(url, 'https://image.novelai.net/ai/generate-image');
      upstreamSignal = init?.signal ?? null;
      return rejectWhenAborted(upstreamSignal, 'NovelAI');
    },
  });

  const response = await withSilencedConsoleError(() => harness.route.POST(jsonRequest(
    { prompt: 'cat' },
    clientController.signal,
  )));
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error, /NovelAI 出图超时/);
  assert.ok(upstreamSignal instanceof AbortSignal);
  assert.equal(upstreamSignal.aborted, true);
});

test('/api/image-gen reuses the custom engine deadline signal for a returned image URL download', async () => {
  const signals = [];
  const harness = createImageGenHarness({
    imageGenSettings: customSettings({ generate_timeout_ms: 5000 }),
    safeFetchImpl: async (url, init) => {
      signals.push(init?.signal ?? null);
      if (url === 'https://images.example/v1/images') {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://cdn.example/image.png') {
        return streamResponse([pngBytes()]).response;
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  const response = await harness.route.POST(jsonRequest({ prompt: 'cat' }));
  assert.equal(response.status, 200);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.equal(signals[1], signals[0]);
});

test('/api/image-gen aborts a stalled NovelAI response body at the configured deadline', async () => {
  let responseBodyCancelled = false;
  const stalledBody = new ReadableStream({
    cancel() {
      responseBodyCancelled = true;
    },
  });
  const harness = createImageGenHarness({
    imageGenSettings: naiSettings({ generate_timeout_ms: 40 }),
    safeFetchImpl: async url => {
      assert.equal(url, 'https://image.novelai.net/ai/generate-image');
      return new Response(stalledBody, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    },
  });

  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    const routePromise = harness.route.POST(jsonRequest({ prompt: 'cat' }));
    result = await Promise.race([
      routePromise,
      new Promise(resolve => setTimeout(() => resolve('still-reading'), 250)),
    ]);
  } finally {
    console.error = originalError;
  }

  assert.notEqual(result, 'still-reading');
  const body = await result.json();
  assert.equal(result.status, 500);
  assert.match(body.error, /NovelAI 出图超时/);
  assert.equal(responseBodyCancelled, true);
});

test('/api/image-gen reuses one ComfyUI deadline signal for prompt, history, and view requests', async () => {
  const signals = new Map();
  const smallImage = streamResponse([pngBytes()]);
  const harness = createImageGenHarness({
    imageGenSettings: comfySettings({ generate_timeout_ms: 5000 }),
    safeFetchImpl: async (url, init) => {
      if (url === 'https://comfy.example/prompt') {
        signals.set('prompt', init?.signal ?? null);
        return new Response(JSON.stringify({ prompt_id: 'prompt-signal' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://comfy.example/history/prompt-signal') {
        signals.set('history', init?.signal ?? null);
        return new Response(JSON.stringify({
          'prompt-signal': {
            outputs: {
              '9': {
                images: [{ filename: 'signal.png', subfolder: '', type: 'output' }],
              },
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://comfy.example/view?filename=signal.png&subfolder=&type=output') {
        signals.set('view', init?.signal ?? null);
        return smallImage.response;
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  const response = await withImmediateComfyPollDelay(
    () => harness.route.POST(jsonRequest({ prompt: 'cat' })),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.url, '/api/files/generated/11111111-1111-4111-8111-111111111111.png');
  assert.ok(signals.get('prompt') instanceof AbortSignal);
  assert.equal(signals.get('history'), signals.get('prompt'));
  assert.equal(signals.get('view'), signals.get('prompt'));
});

test('/api/image-gen aborts the ComfyUI wait stage when the configured deadline expires', async () => {
  const harness = createImageGenHarness({
    imageGenSettings: comfySettings({ generate_timeout_ms: 40 }),
    safeFetchImpl: async url => {
      if (url === 'https://comfy.example/prompt') {
        return new Response(JSON.stringify({ prompt_id: 'prompt-timeout' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`wait should have been aborted before requesting ${url}`);
    },
  });

  const routePromise = withSilencedConsoleError(
    () => harness.route.POST(jsonRequest({ prompt: 'cat' })),
  );
  const result = await Promise.race([
    routePromise,
    new Promise(resolve => setTimeout(() => resolve('still-waiting'), 250)),
  ]);

  assert.notEqual(result, 'still-waiting');
  const body = await result.json();
  assert.equal(result.status, 500);
  assert.match(body.error, /ComfyUI 出图超时/);
  assert.deepEqual(harness.safeFetchCalls.map(call => call.url), ['https://comfy.example/prompt']);
});

test('/api/image-gen aborts the ComfyUI wait stage immediately when the client disconnects', async () => {
  const clientController = new AbortController();
  const harness = createImageGenHarness({
    imageGenSettings: comfySettings({ generate_timeout_ms: 5000 }),
    safeFetchImpl: async url => {
      if (url === 'https://comfy.example/prompt') {
        setTimeout(() => clientController.abort(), 25);
        return new Response(JSON.stringify({ prompt_id: 'prompt-client-abort' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`wait should have been aborted before requesting ${url}`);
    },
  });

  const routePromise = withSilencedConsoleError(() => harness.route.POST(jsonRequest(
    { prompt: 'cat' },
    clientController.signal,
  )));
  const result = await Promise.race([
    routePromise,
    new Promise(resolve => setTimeout(() => resolve('still-waiting'), 250)),
  ]);

  assert.notEqual(result, 'still-waiting');
  const body = await result.json();
  assert.equal(result.status, 500);
  assert.match(body.error, /ComfyUI 出图超时/);
  assert.deepEqual(harness.safeFetchCalls.map(call => call.url), ['https://comfy.example/prompt']);
});

test('image generation timeout settings describe the full pipeline for every engine', () => {
  const translations = fs.readFileSync(path.join(root, 'src/lib/i18n.ts'), 'utf8');
  const types = fs.readFileSync(path.join(root, 'src/types/index.ts'), 'utf8');

  assert.match(translations, /'settings\.imageGenTimeoutHint': '所有生图引擎/);
  assert.match(translations, /'settings\.imageGenTimeoutHint': 'Maximum total wait for all image generation engines/);
  assert.match(types, /适用于所有生图引擎/);
});
