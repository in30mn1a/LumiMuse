const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();

const dbModule = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const originalLoad = Module._load;

function presetSource(overrides = {}) {
  return {
    temperature: 1.08,
    top_p: 0.98,
    frequency_penalty: 0,
    presence_penalty: 0,
    top_k: 0,
    repetition_penalty: 1,
    seed: -1,
    openai_max_tokens: 65535,
    reasoning_effort: 'high',
    prompts: [
      { identifier: 'instruction', name: 'Instruction', role: 'system', content: 'PRESET_INSTRUCTION' },
      { identifier: 'normal', name: 'Normal', role: 'system', content: 'NORMAL_ONLY', injection_trigger: ['normal'] },
      { identifier: 'regenerate', name: 'Regenerate', role: 'system', content: 'REGENERATE_ONLY', injection_trigger: ['regenerate'] },
      { identifier: 'chatHistory', name: 'History', role: 'system', marker: true },
    ],
    prompt_order: [
      { character_id: 100000, order: [] },
      { character_id: 100001, order: ['instruction', 'normal', 'regenerate', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) },
    ],
    ...overrides,
  };
}

async function fixture(run, overrides = {}, respond) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  dbModule.__migrateForTests(db);
  dbModule.__setDbForTests(db);
  db.prepare("INSERT INTO characters(id,name) VALUES('char','Alice')").run();
  db.prepare("INSERT INTO conversations(id,character_id,title) VALUES('conv','char','Test')").run();
  db.prepare("INSERT INTO settings(key,value) VALUES('temperature','0.4')").run();
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    model: 'fixture-model',
    api_base: 'https://fixture.invalid/v1',
    api_key: 'fixture-secret',
    temperature: 0.4,
    max_tokens: 4000,
    top_p: 0.6,
    top_k: 8,
    frequency_penalty: 0.5,
    presence_penalty: -0.2,
    repetition_penalty: 1.2,
    seed: 42,
    reasoning_effort: 'low',
    context_window: 1000000,
    streaming: false,
    show_timestamps: false,
    memory_inject: true,
    limit_inject: false,
    ...overrides,
  };
  const unchangedSettings = structuredClone(settings);
  const requests = [];
  const retrievalSettings = [];
  const mocks = {
    '@/lib/memory-retrieval': {
      retrieveWorkingMemoryPackage: async options => {
        retrievalSettings.push(structuredClone(options.settings));
        return { text: 'PRESERVED_MEMORY', selectedMemories: [{ id: 'memory' }], tokenCount: 5, mode: 'full' };
      },
    },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  };
  const safeFetch = async (url, init) => {
    assert.equal(url, `${settings.api_base}/chat/completions`);
    assert.equal(init.headers.Authorization, `Bearer ${settings.api_key}`);
    const body = JSON.parse(init.body);
    requests.push(body);
    if (respond) return respond(body);
    if (body.stream) {
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Generated response' } }] })}\n\ndata: [DONE]\n\n`);
    }
    return Response.json({ choices: [{ message: { content: 'Generated response' } }] });
  };
  Module._load = function(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    if (request === '@/lib/ssrf-guard' || request === './ssrf-guard') return { safeFetch };
    return originalLoad.call(this, request, parent, isMain);
  };
  for (const file of ['api-client', 'chat-engine', 'prompt-preset-assembler', 'spreset/runtime']) {
    delete require.cache[require.resolve(`../src/lib/${file}.ts`)];
  }
  try {
    const importer = require('../src/lib/prompt-preset-import.ts');
    const presets = require('../src/lib/prompt-presets.ts');
    const { runChat } = require('../src/lib/chat-engine.ts');
    const bind = source => {
      const report = importer.importSillyTavernPreset(JSON.stringify(source), { presetName: 'Standard preset' });
      db.prepare("UPDATE characters SET active_preset_id=? WHERE id='char'").run(report.preset_id);
      return report;
    };
    const chunks = [];
    const chat = async (content = 'CURRENT_MESSAGE', options) => {
      await runChat('conv', content, settings, {
        onChunk(text) { chunks.push(text); },
        onDone() {},
        onError(error) { throw error; },
      }, options);
    };
    await run({ db, settings, unchangedSettings, requests, retrievalSettings, bind, chat, chunks, runChat, presets });
  } finally {
    Module._load = originalLoad;
    dbModule.__resetDbForTests();
  }
}

for (const streaming of [false, true]) {
  test(`preset parameters are ignored by the real ${streaming ? 'streaming' : 'non-streaming'} request and LumiMuse settings remain in control`, async () => {
    await fixture(async h => {
      const report = h.bind(presetSource({ stream_openai: !streaming }));
      assert.equal(Object.hasOwn(report, 'sampling_params'), false);
      assert.equal(Object.hasOwn(h.presets.getPreset(report.preset_id), 'sampling_params'), false);
      await h.chat();
      assert.equal(h.requests.length, 1);
      const body = h.requests[0];
      assert.equal(body.stream, streaming);
      assert.equal(body.model, 'fixture-model');
      assert.equal(body.temperature, 0.4);
      assert.equal(body.top_p, 0.6);
      assert.equal(body.frequency_penalty, 0.5);
      assert.equal(body.presence_penalty, -0.2);
      assert.equal(body.max_tokens, 4000);
      assert.equal(body.reasoning_effort, 'low');
      assert.equal(body.repetition_penalty, 1.2);
      assert.equal(body.top_k, 8);
      assert.equal(body.seed, 42);
      const contents = JSON.stringify(body.messages);
      assert.match(contents, /PRESET_INSTRUCTION/);
      assert.match(contents, /NORMAL_ONLY/);
      assert.doesNotMatch(contents, /REGENERATE_ONLY/);
      assert.match(contents, /CURRENT_MESSAGE/);
      assert.match(contents, /PRESERVED_MEMORY/);
      assert.equal(h.retrievalSettings[0].max_tokens, 4000);
      assert.equal(h.retrievalSettings[0].context_window, 1000000);
      assert.equal(h.retrievalSettings[0].temperature, 0.4);
      assert.deepEqual(h.settings, h.unchangedSettings);
      assert.equal(h.db.prepare("SELECT value FROM settings WHERE key='temperature'").get().value, '0.4');
      assert.equal(h.db.prepare("SELECT content FROM messages WHERE role='assistant'").get().content, 'Generated response');
    }, { streaming });
  });
}

for (const streaming of [false, true]) {
  test(`${streaming ? 'streaming' : 'non-streaming'} regeneration filters trigger-bound prompts while keeping the real input and LumiMuse parameters`, async () => {
    await fixture(async h => {
      h.bind(presetSource({ stream_openai: !streaming }));
      await h.chat();
      const assistantId = h.db.prepare("SELECT id FROM messages WHERE role='assistant'").get().id;
      await h.chat('', { regenerateAssistantId: assistantId, skipUserInsert: true });
      assert.equal(h.requests.length, 2);
      const contents = JSON.stringify(h.requests[1].messages);
      assert.match(contents, /REGENERATE_ONLY/);
      assert.doesNotMatch(contents, /NORMAL_ONLY/);
      assert.match(contents, /CURRENT_MESSAGE/);
      assert.equal(h.requests[1].temperature, h.settings.temperature);
      assert.equal(h.requests[1].max_tokens, h.settings.max_tokens);
      assert.equal(h.requests[1].stream, h.settings.streaming);
      assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='user'").get().n, 1);
    }, { streaming });
  });
}

test('model-specific binding changes prompt selection without changing LumiMuse request settings', async () => {
  await fixture(async h => {
    const report = h.bind(presetSource({ stream_openai: false }));
    h.presets.replaceCharacterModelPresetBindings('char', [{ model: 'fixture-model', preset_id: '__none__' }]);
    await h.chat();
    assert.equal(h.requests[0].temperature, 0.4);
    assert.equal(h.requests[0].max_tokens, 4000);
    assert.equal(h.requests[0].top_k, 8);
    assert.doesNotMatch(JSON.stringify(h.requests[0].messages), /PRESET_INSTRUCTION/);
    h.presets.replaceCharacterModelPresetBindings('char', [{ model: 'fixture-model', preset_id: report.preset_id }]);
    await h.chat('BOUND_MESSAGE');
    assert.equal(h.requests[1].temperature, 0.4);
    assert.equal(h.requests[1].max_tokens, 4000);
    assert.match(JSON.stringify(h.requests[1].messages), /PRESET_INSTRUCTION/);
    h.presets.replaceCharacterModelPresetBindings('char', []);
    h.db.prepare("UPDATE characters SET active_preset_id=NULL WHERE id='char'").run();
    await h.chat('UNBOUND_MESSAGE');
    assert.equal(h.requests[2].temperature, 0.4);
    assert.equal(h.requests[2].max_tokens, 4000);
    assert.deepEqual(h.settings, h.unchangedSettings);
  });
});

test('legacy sampling columns are neither applied nor exposed by an active preset', async () => {
  await fixture(async h => {
    const report = h.bind(presetSource());
    const columns = h.db.pragma('table_info(prompt_presets)');
    if (!columns.some(column => column.name === 'sampling_params')) {
      h.db.exec("ALTER TABLE prompt_presets ADD COLUMN sampling_params TEXT NOT NULL DEFAULT '{}'");
    }
    const legacy = JSON.stringify({ temperature: 1.8, max_tokens: 65535, streaming: true });
    h.db.prepare('UPDATE prompt_presets SET sampling_params=? WHERE id=?').run(legacy, report.preset_id);
    assert.equal(Object.hasOwn(h.presets.getPreset(report.preset_id), 'sampling_params'), false);
    await h.chat();
    assert.equal(h.requests[0].temperature, h.settings.temperature);
    assert.equal(h.requests[0].max_tokens, h.settings.max_tokens);
    assert.equal(h.requests[0].stream, h.settings.streaming);
    assert.equal(h.db.prepare('SELECT sampling_params FROM prompt_presets WHERE id=?').get(report.preset_id).sampling_params, legacy);
  });
});

for (const streaming of [false, true]) {
  test(`plugin request and output scripts reach the real ${streaming ? 'streaming' : 'non-streaming'} save path`, async () => {
    await fixture(async h => {
      h.bind(presetSource({
        extensions: {
          SPreset: {
            FinalRequestProcessing: {
              enabled: true,
              script: '({request}) => ({...request, messages:[{role:"user",content:"PLUGIN_REQUEST"}]})',
            },
            OutputPreprocessing: {
              enabled: true,
              script: '({buffer}) => ({output:buffer.replace("Generated response","PLUGIN_RESPONSE"),hold:"",state:{}})',
            },
          },
        },
      }));
      await h.chat();
      assert.deepEqual(h.requests[0].messages, [{ role: 'user', content: 'PLUGIN_REQUEST' }]);
      assert.equal(h.requests[0].stream, streaming);
      assert.equal(h.db.prepare("SELECT content FROM messages WHERE role='assistant'").get().content, 'PLUGIN_RESPONSE');
      assert.deepEqual(h.settings, h.unchangedSettings);
    }, { streaming });
  });
}

test('a rewritten request may omit stream and still save its JSON response', async () => {
  await fixture(async h => {
    h.bind(presetSource({
      extensions: { SPreset: { FinalRequestProcessing: {
        enabled: true,
        script: '({request}) => { delete request.stream; return request; }',
      } } },
    }));
    await h.chat();
    assert.equal(Object.hasOwn(h.requests[0], 'stream'), false);
    assert.equal(h.db.prepare("SELECT content FROM messages WHERE role='assistant'").get().content, 'Generated response');
  }, { streaming: true });
});

const assistantRows = h => h.db.prepare("SELECT content FROM messages WHERE role='assistant'").all();
const RUNAWAY_SCRIPT = '() => { const f = () => f() + 1; return f(); }';

for (const streaming of [false, true]) {
  test(`${streaming ? 'streaming' : 'non-streaming'} runtime chunks go through strip_tags like the plain path`, async () => {
    await fixture(async h => {
      const report = h.bind(presetSource({
        extensions: { SPreset: { OutputPreprocessing: {
          enabled: true,
          script: '({ buffer }) => ({ output: buffer, hold: "", state: {} })',
        } } },
      }));
      h.db.prepare('UPDATE prompt_presets SET story_plot_strip=1, strip_tags=? WHERE id=?')
        .run(JSON.stringify(['story_plot']), report.preset_id);
      await h.chat();
      const visible = h.chunks.join('');
      assert.equal(visible.includes('story_plot'), false);
      assert.ok(visible.includes('INNER'));
      assert.equal(assistantRows(h).length, 1);
    }, { streaming }, body => {
      const text = '<story_plot>INNER</story_plot>';
      if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
      return Response.json({ choices: [{ message: { content: text } }] });
    });
  });
}

test('a failing request script falls back to a clean assembly that keeps the real user message', async () => {
  await fixture(async h => {
    h.bind(presetSource({
      prompts: [
        { identifier: 'instruction', name: 'Instruction', role: 'system', content: '<<<|catgodml|setLastMessage:{{lastUserMessage}}>>>PRESET_INSTRUCTION' },
        { identifier: 'chatHistory', name: 'History', role: 'system', marker: true },
      ],
      prompt_order: [
        { character_id: 100001, order: ['instruction', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) },
      ],
      extensions: { SPreset: { FinalRequestProcessing: { enabled: true, script: '() => { throw new Error("boom"); }' } } },
    }));
    const warn = console.warn;
    console.warn = () => {};
    try {
      await h.chat();
    } finally {
      console.warn = warn;
    }
    const { messages } = h.requests[0];
    assert.ok(messages.some(message => message.role === 'user' && String(message.content).includes('CURRENT_MESSAGE')));
    assert.equal(JSON.stringify(messages).includes('catgodml'), false);
    assert.ok(JSON.stringify(messages).includes('PRESET_INSTRUCTION'));
    assert.equal(assistantRows(h).length, 1);
  });
});

for (const streaming of [false, true]) {
  test(`runaway plugin scripts keep the ${streaming ? 'streaming' : 'non-streaming'} reply intact`, async () => {
    await fixture(async h => {
      h.bind(presetSource({
        extensions: { SPreset: {
          FinalRequestProcessing: { enabled: true, script: RUNAWAY_SCRIPT },
          OutputPreprocessing: { enabled: true, script: RUNAWAY_SCRIPT },
        } },
      }));
      const warn = console.warn;
      console.warn = () => {};
      try {
        await h.chat();
      } finally {
        console.warn = warn;
      }
      assert.ok(JSON.stringify(h.requests[0].messages).includes('CURRENT_MESSAGE'));
      assert.deepEqual(assistantRows(h).map(row => row.content), ['Generated response']);
    }, { streaming });
  });
}

test('a failed downstream onDone does not store the reply twice', async () => {
  await fixture(async h => {
    h.bind(presetSource({
      extensions: { SPreset: { OutputPreprocessing: {
        enabled: true,
        script: '({ buffer }) => ({ output: buffer, hold: "", state: {} })',
      } } },
    }));
    const errors = [];
    await assert.rejects(h.runChat('conv', 'CURRENT_MESSAGE', h.settings, {
      onChunk() {},
      onDone() { throw new Error('client gone'); },
      onError(error) { errors.push(error); },
    }), /client gone/);
    assert.deepEqual(errors, []);
    assert.equal(assistantRows(h).length, 1);
  });
});

test('stopping a real SSE tool stream never stores incomplete arguments as assistant text', async () => {
  const abort = new AbortController();
  await fixture(async h => {
    h.bind(presetSource({
      extensions: { SPreset: {
        ToolBindings: { instruction: {
          enabled: true, valid: true, resolvedName: 'reply', code: 'return {name:"reply"}',
        } },
        OutputPreprocessing: {
          enabled: true, consumeToolCalls: true,
          toolCallFormatter: { enabled: true, script: '({calls}) => JSON.parse(calls[0].arguments).content' },
        },
      } },
    }));
    await h.chat('CURRENT_MESSAGE', { signal: abort.signal });
    assert.equal(abort.signal.aborted, true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").get().n, 0);
  }, { streaming: true }, () => new Response(new ReadableStream({
    start(controller) {
      const chunk = { choices: [{ delta: { tool_calls: [{
        index: 0, id: 'call-1', function: { name: 'reply', arguments: '{"content":"partial' },
      }] } }] };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
      setImmediate(() => abort.abort());
    },
  })));
});
