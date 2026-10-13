const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();
const dbModule = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const settingsModule = require('../src/lib/settings.ts');
const realApiClient = require('../src/lib/api-client.ts');
const originalLoad = Module._load;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(run) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  dbModule.__migrateForTests(db);
  dbModule.__setDbForTests(db);
  db.prepare("INSERT INTO characters(id,name) VALUES('char','Alice')").run();
  db.prepare("INSERT INTO conversations(id,character_id,title) VALUES('conv','char','Test')").run();
  const settings = { ...DEFAULT_SETTINGS, streaming: false, memory_inject: false,
    context_window: 1000000, api_base: 'https://test.invalid', api_key: 'test', model: 'test' };
  let fetchSummary = async () => 'SUMMARY';
  let completeChat = async () => 'ANSWER';
  let summaryInput;
  let chatInput;
  const mocks = {
    '@/lib/db': dbModule,
    '@/lib/settings': { ...settingsModule, loadSettings: () => settings },
    '@/lib/api-client': { ...realApiClient, chatCompletion: async (_settings, messages) => {
      chatInput = messages;
      return completeChat(messages);
    } },
    '@/lib/ssrf-guard': { safeFetch: async (_url, init) => {
      summaryInput = JSON.parse(init.body).messages;
      const content = await fetchSummary(summaryInput);
      if (content instanceof Response) return content;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
    } },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  };
  Module._load = function(request, parent, isMain) {
    return Object.hasOwn(mocks, request) ? mocks[request] : originalLoad.call(this, request, parent, isMain);
  };
  function fresh(relative) {
    delete require.cache[require.resolve(relative)];
    return require(relative);
  }
  const summary = fresh('../src/app/api/summarize/route.ts');
  const profile = fresh('../src/lib/memory-profile.ts');
  const embeddings = fresh('../src/lib/memory-embeddings.ts');
  const chat = fresh('../src/lib/chat-engine.ts');
  const add = (id, role, content, seq, metadata = {}, conversationId = 'conv') => db.prepare(
    'INSERT INTO messages(id,conversation_id,role,content,seq,metadata) VALUES(?,?,?,?,?,?)',
  ).run(id, conversationId, role, content, seq, JSON.stringify(metadata));
  const request = (conversationId = 'conv') => ({ signal: new AbortController().signal,
    json: async () => ({ conversation_id: conversationId }) });
  const runChat = async (conversationId = 'conv', options, content = 'CURRENT') => {
    await chat.runChat(conversationId, content, settings, {
      onChunk() {}, onDone() {}, onError(error) { throw error; },
    }, options);
    return JSON.stringify(chatInput);
  };
  try {
    await run({ db, settings, summary, profile, embeddings, add, request, runChat, fresh, mocks,
      setSummary: fn => { fetchSummary = fn; }, setChat: fn => { completeChat = fn; },
      summaryText: () => JSON.stringify(summaryInput) });
  } finally {
    Module._load = originalLoad;
    dbModule.__resetDbForTests();
  }
}

test('repeated summary preserves previous facts and cumulative coverage in actual next chat', async () => {
  await fixture(async h => {
    h.add('old-u', 'user', 'OLD_FACT', 1);
    h.add('old-a', 'assistant', 'OLD_ANSWER', 2);
    h.add('old-s', 'system', 'OLD_FACT', 3, { isSummary: true, summarizedIds: ['old-u', 'old-a'] });
    h.add('new-u', 'user', 'NEW_FACT', 4);
    h.add('new-a', 'assistant', 'NEW_ANSWER', 5);
    h.setSummary(async messages => {
      assert.match(JSON.stringify(messages), /OLD_FACT/);
      assert.match(JSON.stringify(messages), /NEW_FACT/);
      return 'OLD_FACT + NEW_FACT';
    });
    const response = await h.summary.POST(h.request());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.message.metadata.summaryCoverageVersion, 1);
    assert.deepEqual(new Set(body.message.metadata.summarizedIds), new Set(['old-u', 'old-a', 'old-s', 'new-u', 'new-a']));
    const next = await h.runChat();
    assert.match(next, /OLD_FACT \+ NEW_FACT/);
    assert.doesNotMatch(next, /NEW_ANSWER|OLD_ANSWER/);
  });
});

test('summary coverage excludes concurrent writes, and next chat keeps them', async () => {
  await fixture(async h => {
    h.add('u', 'user', 'BEFORE', 1); h.add('a', 'assistant', 'BEFORE_ANSWER', 2);
    const started = deferred(); const finish = deferred();
    h.setSummary(async () => { started.resolve(); await finish.promise; return 'SNAPSHOT_SUMMARY'; });
    const pending = h.summary.POST(h.request());
    await started.promise;
    h.add('during-u', 'user', 'DURING_FACT', 3); h.add('during-a', 'assistant', 'DURING_ANSWER', 4);
    finish.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(!body.message.metadata.summarizedIds.includes('during-u'));
    assert.doesNotMatch(h.summaryText(), /DURING_FACT/);
    assert.match(await h.runChat(), /DURING_FACT/);
    const seqs = h.db.prepare("SELECT seq FROM messages WHERE conversation_id='conv'").all().map(row => row.seq);
    assert.equal(new Set(seqs).size, seqs.length);
  });
});

test('summary SSE error after partial text leaves original facts active without persisting a summary', async () => {
  await fixture(async h => {
    h.add('u', 'user', 'ORIGINAL_FACT', 1); h.add('a', 'assistant', 'ORIGINAL_ANSWER', 2);
    h.setSummary(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'PARTIAL_FAILED_SUMMARY' } }] })}\n\n`
      + `data: ${JSON.stringify({ error: { message: 'upstream generation failed' } })}\n\ndata: [DONE]\n\n`,
    ));
    const response = await h.summary.POST(h.request());
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /upstream generation failed/);
    assert.equal(h.db.prepare("SELECT count(*) AS n FROM messages WHERE content='PARTIAL_FAILED_SUMMARY'").get().n, 0);
    assert.equal(h.db.prepare("SELECT count(*) AS n FROM messages WHERE json_extract(metadata,'$.isSummary')=1").get().n, 0);
    const nextChat = await h.runChat();
    assert.match(nextChat, /ORIGINAL_FACT/);
    assert.match(nextChat, /ORIGINAL_ANSWER/);
  });
});

test('input edits and concurrent summaries reject stale generated summary with 409', async () => {
  for (const conflict of ['edit', 'summary']) {
    await fixture(async h => {
      h.add('u', 'user', 'BEFORE', 1); h.add('a', 'assistant', 'ANSWER', 2);
      const started = deferred(); const finish = deferred();
      h.setSummary(async () => { started.resolve(); await finish.promise; return 'STALE_SUMMARY'; });
      const pending = h.summary.POST(h.request());
      await started.promise;
      if (conflict === 'edit') h.db.prepare("UPDATE messages SET content='EDITED' WHERE id='u'").run();
      else h.add('other-s', 'system', 'OTHER_SUMMARY', 3, { isSummary: true });
      finish.resolve();
      assert.equal((await pending).status, 409);
      assert.equal(h.db.prepare("SELECT count(*) AS n FROM messages WHERE content='STALE_SUMMARY'").get().n, 0);
    });
  }
});

test('linked summary includes only inherited range and un-covered insertion before the summary', async () => {
  await fixture(async h => {
    h.add('parent-u', 'user', 'PARENT_FACT', 1); h.add('parent-a', 'assistant', 'PARENT_ANSWER', 2);
    h.add('parent-s', 'system', 'PARENT_FACT', 3, { isSummary: true, summaryCoverageVersion: 1, summarizedIds: ['parent-u', 'parent-a'] });
    h.add('outside', 'user', 'OUTSIDE_RANGE', 10);
    h.db.prepare("INSERT INTO conversations(id,character_id,title,parent_id,parent_seq_end) VALUES('child','char','Child','conv',3)").run();
    h.add('inserted', 'assistant', 'INSERTED_FACT', 2, {}, 'child');
    h.add('child-u', 'user', 'CHILD_FACT', 4, {}, 'child');
    h.setSummary(async messages => {
      const text = JSON.stringify(messages);
      assert.match(text, /PARENT_FACT|INSERTED_FACT|CHILD_FACT/);
      assert.ok(text.includes('PARENT_FACT') && text.includes('INSERTED_FACT') && text.includes('CHILD_FACT'));
      assert.doesNotMatch(text, /OUTSIDE_RANGE|PARENT_ANSWER/);
      return 'PARENT_FACT INSERTED_FACT CHILD_FACT';
    });
    assert.equal((await h.summary.POST(h.request('child'))).status, 200);
    assert.doesNotMatch(await h.runChat('child'), /OUTSIDE_RANGE|PARENT_ANSWER/);
  });
});

test('linked history insertion during generation survives sequence shifts and harmless metadata updates', async () => {
  await fixture(async h => {
    h.add('parent-u', 'user', 'PARENT_FACT', 1); h.add('parent-a', 'assistant', 'PARENT_ANSWER', 2);
    h.add('parent-s', 'system', 'PARENT_FACT', 3, { isSummary: true, summaryCoverageVersion: 1, summarizedIds: ['parent-u', 'parent-a'] });
    h.db.prepare("INSERT INTO conversations(id,character_id,title,parent_id,parent_seq_end) VALUES('child','char','Child','conv',3)").run();
    h.add('child-u', 'user', 'CHILD_FACT', 4, {}, 'child');
    h.add('child-a', 'assistant', 'CHILD_ANSWER', 5, {}, 'child');
    const started = deferred(); const finish = deferred();
    h.setSummary(async () => { started.resolve(); await finish.promise; return 'PARENT_FACT CHILD_FACT'; });
    const pending = h.summary.POST(h.request('child'));
    await started.promise;
    h.db.prepare("UPDATE messages SET metadata=? WHERE id='child-u'").run(JSON.stringify({ memory_extracted: true }));
    h.setChat(async () => 'INSERTED_DURING');
    await h.runChat('child', { insertAssistantAfterUserId: 'parent-u' }, '');
    finish.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.doesNotMatch(h.summaryText(), /INSERTED_DURING/);
    const inserted = h.db.prepare("SELECT id FROM messages WHERE content='INSERTED_DURING'").get();
    const body = await response.json();
    assert.ok(!body.message.metadata.summarizedIds.includes(inserted.id));
    h.setChat(async () => 'NEXT_ANSWER');
    assert.match(await h.runChat('child'), /INSERTED_DURING/);
  });
});

test('physical and character copies remap summary coverage while linked copies preserve inherited IDs', async () => {
  for (const mode of ['full', 'linked', 'character']) {
    await fixture(async h => {
      h.add('covered-u', 'user', 'COVERED_OLD_FACT', 1);
      h.add('covered-a', 'assistant', 'COVERED_OLD_ANSWER', 2);
      h.add('source-summary', 'system', 'MERGED_FACT', 3, { isSummary: true,
        summaryCoverageVersion: 1, summarizedIds: ['covered-u', 'covered-a', 'covered-late'] });
      h.add('uncovered-u', 'user', 'UNCOVERED_DURING', 4);
      h.add('uncovered-a', 'assistant', 'UNCOVERED_ANSWER', 5);
      h.add('covered-late', 'assistant', 'COVERED_LATE_ANSWER', 6);
      let copiedConversationId;
      if (mode === 'character') {
        const route = h.fresh('../src/app/api/characters/[id]/duplicate/route.ts');
        const response = await route.POST({}, { params: Promise.resolve({ id: 'char' }) });
        assert.equal(response.status, 201);
        const copy = await response.json();
        copiedConversationId = h.db.prepare('SELECT id FROM conversations WHERE character_id=?').get(copy.id).id;
      } else {
        const route = h.fresh('../src/app/api/conversations/[id]/duplicate/route.ts');
        const response = await route.POST(new Request('http://test/api/duplicate', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }),
        { params: Promise.resolve({ id: 'conv' }) });
        assert.equal(response.status, 201);
        copiedConversationId = (await response.json()).id;
      }
      if (mode !== 'linked') {
        const copiedMessages = h.db.prepare('SELECT * FROM messages WHERE conversation_id=?').all(copiedConversationId);
        const summary = copiedMessages.find(message => message.content === 'MERGED_FACT');
        const covered = JSON.parse(summary.metadata).summarizedIds;
        assert.deepEqual(new Set(covered), new Set(copiedMessages
          .filter(message => message.content.startsWith('COVERED_')).map(message => message.id)));
        assert.ok(!covered.includes('covered-u'));
      } else {
        assert.equal(h.db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id=?').get(copiedConversationId).n, 0);
      }
      const nextChat = await h.runChat(copiedConversationId);
      assert.match(nextChat, /MERGED_FACT/);
      assert.match(nextChat, /UNCOVERED_DURING/);
      assert.doesNotMatch(nextChat, /COVERED_OLD|COVERED_LATE/);
    });
  }
});

test('generated profile patch preserves concurrent manual fields while applying independent fields', async () => {
  await fixture(async h => {
    h.profile.patchMemoryProfile('char', { relationship_state: 'INITIAL', open_threads: ['OLD'] }, h.db);
    const task = h.profile.enqueueMemoryProfilePatchExtraction('char', 'SOURCE', 'memory_extraction', h.db);
    const started = deferred(); const finish = deferred();
    const pending = h.profile.processMemoryProfileUpdateTasks({ db: h.db, taskId: task.id,
      generatePatch: async () => { started.resolve(); await finish.promise;
        return { relationship_state: 'STALE', open_threads: ['STALE'], recent_story_state: 'NEW_STORY' }; } });
    await started.promise;
    const manual = h.profile.enqueueMemoryProfileUpdate('char', { relationship_state: 'MANUAL', open_threads: ['MANUAL'] }, 'manual_edit', h.db);
    await h.profile.processMemoryProfileUpdateTasks({ db: h.db, taskId: manual.id });
    finish.resolve(); await pending;
    const latest = h.profile.readMemoryProfile('char', h.db);
    assert.equal(latest.relationship_state, 'MANUAL');
    assert.deepEqual(latest.open_threads, ['MANUAL']);
    assert.equal(latest.recent_story_state, 'NEW_STORY');
    assert.match(h.profile.getMemoryProfileUpdateTasks('char', h.db).find(row => row.id === task.id).error_message, /conflicting fields preserved/);
  });
});

test('embedding text changed during single and batch generation is queued again and rebuilt', async () => {
  for (const batch of [false, true]) {
    await fixture(async h => {
      h.db.prepare("INSERT INTO memories(id,character_id,category,content) VALUES('mem','char','topic','OLD_TEXT')").run();
      h.embeddings.enqueueMemoryEmbeddingTask('mem', 'char', 'created', h.db);
      const started = deferred(); const finish = deferred();
      const embed = async () => { started.resolve(); await finish.promise; return [1, 0]; };
      const config = { model: 'test-embedding', dimension: 2 };
      const pending = h.embeddings.processMemoryEmbeddingTasks(config, { db: h.db,
        ...(batch ? { embedBatch: async () => [await embed()] } : { embed }) });
      await started.promise;
      h.db.prepare("UPDATE memories SET content='NEW_TEXT' WHERE id='mem'").run();
      assert.equal(h.embeddings.enqueueMemoryEmbeddingTask('mem', 'char', 'updated', h.db), false);
      finish.resolve(); await pending;
      assert.equal(h.db.prepare("SELECT status FROM memory_embedding_tasks WHERE memory_id='mem'").get().status, 'pending');
      assert.equal(h.db.prepare("SELECT count(*) AS n FROM memory_embeddings WHERE memory_id='mem'").get().n, 0);
      await h.embeddings.processMemoryEmbeddingTasks(config, { db: h.db, embed: async text => {
        assert.match(text, /NEW_TEXT/); return [0, 1];
      } });
      const memory = h.db.prepare("SELECT * FROM memories WHERE id='mem'").get();
      const embedding = h.db.prepare("SELECT * FROM memory_embeddings WHERE memory_id='mem'").get();
      assert.equal(embedding.embedding_text_hash, h.embeddings.hashEmbeddingText(h.embeddings.buildMemoryEmbeddingText(memory)));
    });
  }
});

test('short fact reaches real extraction queue and persists memory without noop marker', async () => {
  await fixture(async h => {
    h.add('short', 'user', 'My name is Jo.', 1);
    let extractionCalls = 0;
    h.setChat(async messages => {
      const text = JSON.stringify(messages);
      extractionCalls += 1;
      assert.match(text, /My name is Jo\./);
      return JSON.stringify({ memories: [{ category: '用户信息', content: 'The user name is Jo.',
        memory_kind: 'general', lifecycle_action: 'insert', importance: 0.8 }] });
    });
    h.mocks['@/lib/memory-profile'] = { enqueueMemoryProfilePatchExtraction() {}, triggerMemoryProfileQueue() {},
      readMemoryProfile: () => null, renderMemoryProfile: () => '' };
    h.fresh('../src/lib/memory-engine.ts');
    h.fresh('../src/lib/memory-extraction-reference.ts');
    const queue = h.fresh('../src/lib/memory-queue.ts');
    const taskId = Number(h.db.prepare("INSERT INTO memory_tasks(character_id,conversation_id,message_ids) VALUES('char','conv',?)")
      .run(JSON.stringify(['short'])).lastInsertRowid);
    await queue.__processQueueForTest();
    assert.ok(extractionCalls > 0);
    assert.equal(h.db.prepare('SELECT status FROM memory_tasks WHERE id=?').get(taskId).status, 'done');
    const metadata = JSON.parse(h.db.prepare("SELECT metadata FROM messages WHERE id='short'").get().metadata);
    assert.equal(metadata.memory_extracted, true);
    assert.equal(metadata.memory_noop_extracted_at, undefined);
    assert.match(h.db.prepare("SELECT content FROM memories WHERE source_msg_ids LIKE '%short%'").get().content, /Jo/);
  });
});

test('message edited during the extraction LLM window is not marked extracted', async () => {
  await fixture(async h => {
    h.add('edited', 'user', 'My name is Jo.', 1);
    h.add('stable', 'user', 'I live in Oslo.', 2);
    h.setChat(async () => {
      // 用户在提取 LLM 等待期间改了这条消息：新内容没有被本轮提取读到
      h.db.prepare("UPDATE messages SET content = 'My name is Max.' WHERE id = 'edited'").run();
      return JSON.stringify({ memories: [{ category: '用户信息', content: 'The user name is Jo and lives in Oslo.',
        memory_kind: 'general', lifecycle_action: 'insert', importance: 0.8 }] });
    });
    h.mocks['@/lib/memory-profile'] = { enqueueMemoryProfilePatchExtraction() {}, triggerMemoryProfileQueue() {},
      readMemoryProfile: () => null, renderMemoryProfile: () => '' };
    h.fresh('../src/lib/memory-engine.ts');
    h.fresh('../src/lib/memory-extraction-reference.ts');
    const queue = h.fresh('../src/lib/memory-queue.ts');
    const taskId = Number(h.db.prepare("INSERT INTO memory_tasks(character_id,conversation_id,message_ids) VALUES('char','conv',?)")
      .run(JSON.stringify(['edited', 'stable'])).lastInsertRowid);
    await queue.__processQueueForTest();
    assert.equal(h.db.prepare('SELECT status FROM memory_tasks WHERE id=?').get(taskId).status, 'done');
    const metadataOf = id => JSON.parse(h.db.prepare('SELECT metadata FROM messages WHERE id=?').get(id).metadata);
    // 改过的消息留给下一轮提取；没改的照常标记
    assert.notEqual(metadataOf('edited').memory_extracted, true);
    assert.equal(metadataOf('stable').memory_extracted, true);
  });
});

test('data-only image attachment reaches the same-turn prompt without being stored', async () => {
  await fixture(async h => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const prompt = await h.runChat('conv', {
      attachments: [{ type: 'image', name: 'inline.png', data: dataUrl, mimeType: 'image/png' }],
    }, 'LOOK_AT_THIS');
    // schema 接受无 URL 的 base64 图片：它必须真的作为多模态输入送到本轮模型
    assert.match(prompt, /LOOK_AT_THIS/);
    assert.ok(prompt.includes(dataUrl), '本轮 prompt 必须带上 data-only 图片');
    // 仍然不落库（避免 DB 体积爆炸）
    const stored = h.db.prepare("SELECT metadata FROM messages WHERE role = 'user' AND content = 'LOOK_AT_THIS'").get();
    assert.ok(!stored.metadata.includes('base64'));
  });
});
