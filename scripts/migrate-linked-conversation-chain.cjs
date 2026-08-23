#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const MIGRATION_ID = 'shinozawa-hiro-linked-chain-v1';
const TARGET_CHARACTER_NAME = '篠澤広';

const DEFAULT_TARGET_CONVERSATIONS = Object.freeze({
  root: {
    title: '2026.5.12-2026.5.31',
  },
  part3: {
    title: '2026.6.1-2026.7.2',
  },
  part4: {
    title: '2026.7.3 - 2026.8.2',
  },
  part5: {
    title: '2026.8.3 -',
  },
});

// The default chain is kept for the local fixture/database. Production databases may have
// a different number of copied segments, so the CLI can replace this spec at runtime.
const DEFAULT_LINK_STEPS = Object.freeze([
  Object.freeze({ parentKey: 'root', childKey: 'part3' }),
  Object.freeze({ parentKey: 'part3', childKey: 'part4' }),
  Object.freeze({ parentKey: 'part4', childKey: 'part5' }),
]);

let activeTargetSpec = {
  characterName: TARGET_CHARACTER_NAME,
  conversations: DEFAULT_TARGET_CONVERSATIONS,
  linkSteps: DEFAULT_LINK_STEPS,
};
let activeTargetContext = null;

function targetConversations() {
  return activeTargetSpec.conversations;
}

function linkSteps() {
  return activeTargetSpec.linkSteps;
}

function makeTargetSpec(characterName, titles) {
  if (typeof characterName !== 'string' || characterName.trim() === '') {
    fail('INVALID_ARGUMENT', 'character name must be a non-empty string');
  }
  if (!Array.isArray(titles) || titles.length < 2) {
    fail('INVALID_ARGUMENT', 'at least two --chain-title values are required');
  }
  const normalizedTitles = titles.map(title => {
    if (typeof title !== 'string' || title.trim() === '') {
      fail('INVALID_ARGUMENT', '--chain-title values must be non-empty strings');
    }
    return title;
  });
  if (new Set(normalizedTitles).size !== normalizedTitles.length) {
    fail('INVALID_ARGUMENT', '--chain-title values must be unique');
  }
  const conversations = {};
  normalizedTitles.forEach((title, index) => {
    const key = index === 0 ? 'root' : `part${index + 2}`;
    conversations[key] = Object.freeze({ title });
  });
  const linkSteps = normalizedTitles.slice(1).map((_, index) => Object.freeze({
    parentKey: index === 0 ? 'root' : `part${index + 2}`,
    childKey: `part${index + 3}`,
  }));
  return Object.freeze({
    characterName,
    conversations: Object.freeze(conversations),
    linkSteps: Object.freeze(linkSteps),
  });
}

function normalizeTargetSpec(spec) {
  if (spec === undefined) {
    return {
      characterName: TARGET_CHARACTER_NAME,
      conversations: DEFAULT_TARGET_CONVERSATIONS,
      linkSteps: DEFAULT_LINK_STEPS,
    };
  }
  if (!spec || typeof spec !== 'object') fail('INVALID_ARGUMENT', 'targetSpec must be an object');
  const conversations = spec.conversations;
  if (!conversations || typeof conversations !== 'object') {
    fail('INVALID_ARGUMENT', 'targetSpec.conversations is required');
  }
  const keys = Object.keys(conversations);
  if (keys.length < 2 || keys[0] !== 'root') {
    fail('INVALID_ARGUMENT', 'targetSpec.conversations must start with root and contain a child');
  }
  const titles = keys.map(key => conversations[key]?.title);
  return makeTargetSpec(spec.characterName ?? TARGET_CHARACTER_NAME, titles);
}

function targetConversation(key) {
  const target = activeTargetContext?.conversations[key];
  if (!target) fail('TARGET_NOT_RESOLVED', `target conversation is not resolved: ${key}`);
  return target;
}

function targetConversationId(key) {
  return targetConversation(key).id;
}

function targetCharacterId() {
  if (!activeTargetContext?.characterId) fail('TARGET_NOT_RESOLVED', 'target character is not resolved');
  return activeTargetContext.characterId;
}

const COPIED_MESSAGE_FIELDS = Object.freeze([
  'role',
  'content',
  'token_count',
  'created_at',
  'metadata',
]);

const APPROVED_JSON_REFERENCE_FIELDS = Object.freeze([
  Object.freeze({ table: 'messages', column: 'metadata' }),
  Object.freeze({ table: 'memories', column: 'source_msg_ids' }),
  Object.freeze({ table: 'memories', column: 'metadata' }),
  Object.freeze({ table: 'memory_tasks', column: 'message_ids' }),
  Object.freeze({ table: 'memory_extraction_candidates', column: 'raw_candidate_json' }),
]);

// These fields are JSON-bearing but are not established message-id authorities. Finding a
// soon-to-be-deleted id in one is therefore a stop condition rather than an invitation to guess.
const UNEXPECTED_JSON_REFERENCE_FIELDS = Object.freeze([
  Object.freeze({ table: 'character_memory_profile_update_tasks', column: 'patch_json' }),
  Object.freeze({ table: 'character_memory_profile_versions', column: 'snapshot_json' }),
  Object.freeze({ table: 'character_memory_profiles', column: 'open_threads' }),
  Object.freeze({ table: 'memories', column: 'tags' }),
  Object.freeze({ table: 'memory_extraction_candidates', column: 'raw_response' }),
  Object.freeze({ table: 'prompt_presets', column: 'strip_tags' }),
  Object.freeze({ table: 'settings', column: 'value' }),
  Object.freeze({ table: 'model_cache', column: 'models' }),
]);

class MigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MigrationError(code, message);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function loadDatabaseConstructor() {
  try {
    return require('better-sqlite3');
  } catch (localError) {
    try {
      // The production image is a Next.js standalone image. A script copied to /tmp does not
      // inherit /app's module search path, so resolve dependencies as if loaded by server.js.
      return createRequire('/app/server.js')('better-sqlite3');
    } catch {
      throw localError;
    }
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function columnExists(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .some(row => row.name === column);
}

function requireSchema(db) {
  for (const table of ['conversations', 'messages']) {
    if (!tableExists(db, table)) {
      fail('SCHEMA_NOT_READY', `required table is missing: ${table}`);
    }
  }
  for (const column of ['parent_id', 'parent_seq_end']) {
    if (!columnExists(db, 'conversations', column)) {
      fail('SCHEMA_NOT_READY', `conversations.${column} is missing; deploy the linked-chain build first`);
    }
  }
  for (const column of [
    'id', 'conversation_id', 'role', 'content', 'token_count', 'created_at', 'seq', 'metadata',
  ]) {
    if (!columnExists(db, 'messages', column)) {
      fail('SCHEMA_NOT_READY', `messages.${column} is missing`);
    }
  }
}

function getConversationRows(db) {
  if (!tableExists(db, 'characters') || !columnExists(db, 'characters', 'name')) {
    fail('SCHEMA_NOT_READY', 'characters.name is required to resolve the migration target');
  }
  const characterRows = db.prepare(
    'SELECT id FROM characters WHERE name = ? ORDER BY id',
  ).all(activeTargetSpec.characterName);
  if (characterRows.length === 0) {
    fail('TARGET_NOT_FOUND', `target character is missing: ${activeTargetSpec.characterName}`);
  }
  if (characterRows.length !== 1) {
    fail('TARGET_AMBIGUOUS', `target character name is not unique: ${activeTargetSpec.characterName}`);
  }
  const characterId = characterRows[0].id;
  const stmt = db.prepare(`
    SELECT id, character_id, title, parent_id, parent_seq_end
    FROM conversations
    WHERE character_id = ? AND title = ?
  `);
  const rows = new Map();
  for (const [key, expected] of Object.entries(targetConversations())) {
    const matches = stmt.all(characterId, expected.title);
    if (matches.length === 0) {
      fail('TARGET_NOT_FOUND', `target conversation is missing: ${expected.title}`);
    }
    if (matches.length !== 1) {
      fail('TARGET_AMBIGUOUS', `target conversation title is not unique: ${expected.title}`);
    }
    const row = matches[0];
    rows.set(key, row);
  }
  activeTargetContext = {
    characterId,
    conversations: Object.fromEntries([...rows].map(([key, row]) => [key, row])),
  };
  return rows;
}

function getMessages(db, conversationId, order = 'seq') {
  const orderSql = order === 'created'
    ? 'created_at ASC, seq ASC, rowid ASC'
    : 'seq ASC, rowid ASC';
  return db.prepare(`
    SELECT rowid AS storage_rowid, id, conversation_id, role, content,
           token_count, created_at, seq, metadata
    FROM messages
    WHERE conversation_id = ?
    ORDER BY ${orderSql}
  `).all(conversationId);
}

function assertUniqueIntegerSeq(rows, conversationId) {
  const seen = new Set();
  for (const row of rows) {
    if (!Number.isInteger(row.seq) || row.seq < 1) {
      fail('INVALID_SEQ', `conversation ${conversationId} has a non-positive or non-integer seq`);
    }
    if (seen.has(row.seq)) {
      fail('DUPLICATE_SEQ', `conversation ${conversationId} has duplicate seq ${row.seq}`);
    }
    seen.add(row.seq);
  }
}

function assertContiguousSeq(rows, start, label) {
  for (let index = 0; index < rows.length; index += 1) {
    const expected = start + index;
    if (rows[index].seq !== expected) {
      fail('NON_CONTIGUOUS_SEQ', `${label} expected seq ${expected}, found ${rows[index].seq}`);
    }
  }
}

function differingCopiedFields(parent, child) {
  return COPIED_MESSAGE_FIELDS.filter(field => parent[field] !== child[field]);
}

function composeSurvivorMap(directMap) {
  const result = new Map();
  for (const candidateId of directMap.keys()) {
    const visited = new Set();
    let survivorId = candidateId;
    while (directMap.has(survivorId)) {
      if (visited.has(survivorId)) {
        fail('MAPPING_CYCLE', 'duplicate-to-survivor mapping contains a cycle');
      }
      visited.add(survivorId);
      survivorId = directMap.get(survivorId);
    }
    result.set(candidateId, survivorId);
  }
  return result;
}

function remapJsonValue(value, survivorMap, stats, jsonPath = '$') {
  if (typeof value === 'string') {
    if (!survivorMap.has(value)) return value;
    stats.referenceCount += 1;
    stats.candidateIds.add(value);
    stats.mappedIds.add(survivorMap.get(value));
    stats.paths.add(jsonPath.replace(/\[\d+\]/g, '[]'));
    return survivorMap.get(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => remapJsonValue(
      item,
      survivorMap,
      stats,
      `${jsonPath}[${index}]`,
    ));
  }
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const mappedKey = survivorMap.get(key) ?? key;
    if (Object.prototype.hasOwnProperty.call(output, mappedKey)) {
      fail('JSON_KEY_COLLISION', `message-id remapping would collide at ${jsonPath}`);
    }
    if (mappedKey !== key) {
      stats.referenceCount += 1;
      stats.candidateIds.add(key);
      stats.mappedIds.add(mappedKey);
      stats.paths.add(`${jsonPath}.<key>`);
    }
    output[mappedKey] = remapJsonValue(item, survivorMap, stats, `${jsonPath}.${key}`);
  }
  return output;
}

function findCandidateSubstring(raw, candidateIds) {
  if (typeof raw !== 'string') return null;
  for (const id of candidateIds) {
    if (raw.includes(id)) return id;
  }
  return null;
}

function scanJsonField(db, descriptor, survivorMap, approved) {
  const { table, column } = descriptor;
  if (!columnExists(db, table, column)) {
    return {
      table,
      column,
      present: false,
      documentCount: 0,
      referenceCount: 0,
      malformedCount: 0,
      updates: [],
      paths: [],
      distinctCandidateCount: 0,
      distinctSurvivorCount: 0,
    };
  }

  const rows = db.prepare(`
    SELECT rowid AS storage_rowid, ${quoteIdentifier(column)} AS raw_json
    FROM ${quoteIdentifier(table)}
  `).all();
  const updates = [];
  const paths = new Set();
  const allCandidateIds = new Set();
  const allMappedIds = new Set();
  let documentCount = 0;
  let referenceCount = 0;
  let malformedCount = 0;

  for (const row of rows) {
    if (typeof row.raw_json !== 'string') continue;
    let parsed;
    try {
      parsed = JSON.parse(row.raw_json);
    } catch {
      malformedCount += 1;
      if (findCandidateSubstring(row.raw_json, survivorMap.keys())) {
        fail(
          'MALFORMED_JSON_REFERENCE',
          `${table}.${column} contains a candidate id in malformed JSON`,
        );
      }
      continue;
    }

    const stats = {
      referenceCount: 0,
      candidateIds: new Set(),
      mappedIds: new Set(),
      paths: new Set(),
    };
    const remapped = remapJsonValue(parsed, survivorMap, stats);
    if (stats.referenceCount === 0) continue;

    documentCount += 1;
    referenceCount += stats.referenceCount;
    for (const value of stats.candidateIds) allCandidateIds.add(value);
    for (const value of stats.mappedIds) allMappedIds.add(value);
    for (const value of stats.paths) paths.add(value);

    if (!approved) {
      fail(
        'UNEXPECTED_JSON_REFERENCE',
        `${table}.${column} contains ${stats.referenceCount} candidate message-id reference(s)`,
      );
    }
    if (stats.candidateIds.size !== stats.mappedIds.size) {
      fail(
        'REFERENCE_COLLAPSE',
        `${table}.${column} would collapse distinct references within one document`,
      );
    }
    updates.push({
      table,
      column,
      storageRowid: row.storage_rowid,
      oldValue: row.raw_json,
      newValue: JSON.stringify(remapped),
      referenceCount: stats.referenceCount,
    });
  }

  return {
    table,
    column,
    present: true,
    documentCount,
    referenceCount,
    malformedCount,
    updates,
    paths: [...paths].sort(),
    distinctCandidateCount: allCandidateIds.size,
    distinctSurvivorCount: allMappedIds.size,
  };
}

function analyzeJsonReferences(db, survivorMap) {
  const approved = APPROVED_JSON_REFERENCE_FIELDS.map(field => (
    scanJsonField(db, field, survivorMap, true)
  ));
  for (const field of UNEXPECTED_JSON_REFERENCE_FIELDS) {
    scanJsonField(db, field, survivorMap, false);
  }
  return {
    approved,
    updates: approved.flatMap(field => field.updates),
  };
}

function assertNoInflightTargetWork(db, candidateIds = null) {
  const ids = Object.keys(targetConversations()).map(targetConversationId);
  const placeholders = ids.map(() => '?').join(', ');
  if (tableExists(db, 'memory_tasks')) {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_tasks
      WHERE conversation_id IN (${placeholders})
        AND status IN ('pending', 'processing')
    `).get(...ids);
    if (row.count > 0) {
      fail('INFLIGHT_MEMORY_TASKS', `target conversations have ${row.count} in-flight memory task(s)`);
    }
  }
  if (tableExists(db, 'memory_extraction_candidates')) {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_extraction_candidates
      WHERE conversation_id IN (${placeholders}) AND status = 'pending'
    `).get(...ids);
    if (row.count > 0) {
      fail('PENDING_MEMORY_CANDIDATES', `target conversations have ${row.count} pending review candidate(s)`);
    }
  }

  if (candidateIds && candidateIds.size > 0 && tableExists(db, 'memory_tasks')) {
    const candidateJson = JSON.stringify([...candidateIds]);
    const row = db.prepare(`
      SELECT task.id
      FROM memory_tasks AS task
      WHERE task.status IN ('pending', 'processing')
        AND json_valid(task.message_ids)
        AND EXISTS (
          SELECT 1
          FROM json_each(task.message_ids) AS task_message
          INNER JOIN json_each(?) AS candidate
            ON candidate.value = task_message.value
          WHERE task_message.type = 'text'
        )
      LIMIT 1
    `).get(candidateJson);
    if (row) {
      fail(
        'INFLIGHT_CANDIDATE_MESSAGES',
        `an in-flight memory task references a message selected for deletion (task ${row.id})`,
      );
    }
  }
}

function countMessages(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
}

function countChainMessages(db) {
  const ids = Object.keys(targetConversations()).map(targetConversationId);
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(
    `SELECT COUNT(*) AS count FROM messages WHERE conversation_id IN (${placeholders})`,
  ).get(...ids).count;
}

function detectState(conversations) {
  const root = conversations.get('root');
  if (root.parent_id !== null || root.parent_seq_end !== null) {
    fail('PARTIAL_STATE', 'the chain root unexpectedly has a parent reference');
  }
  const children = linkSteps().map(step => conversations.get(step.childKey));
  const allUnlinked = children.every(row => row.parent_id === null && row.parent_seq_end === null);
  if (allUnlinked) return 'pending';

  const allPointToExpectedParent = linkSteps().every(step => (
    conversations.get(step.childKey).parent_id === targetConversationId(step.parentKey)
  ));
  if (allPointToExpectedParent) return 'linked';
  fail('PARTIAL_STATE', 'target conversations are in a mixed or unexpected link state');
}

function resolveChain(db, conversationId) {
  const stmt = db.prepare(
    'SELECT parent_id, parent_seq_end FROM conversations WHERE id = ?',
  );
  const chain = [{ conversationId, seqEnd: null }];
  const visited = new Set([conversationId]);
  let cursor = conversationId;
  while (true) {
    const row = stmt.get(cursor);
    if (!row || !row.parent_id || row.parent_seq_end === null) break;
    if (visited.has(row.parent_id)) fail('CHAIN_CYCLE', 'target conversation chain contains a cycle');
    visited.add(row.parent_id);
    chain.unshift({ conversationId: row.parent_id, seqEnd: row.parent_seq_end });
    cursor = row.parent_id;
  }
  return chain;
}

function validatePlannedVisibleOrder(plan) {
  let plannedRows = plan.snapshotsByKey.get('root').map(row => ({ ...row, plannedSeq: row.seq }));
  for (const step of linkSteps()) {
    const bound = plan.expectedBounds.get(step.childKey);
    const retained = plan.retainedByKey.get(step.childKey).map((row, index) => ({
      ...row,
      plannedSeq: bound + index + 1,
    }));
    plannedRows = [...plannedRows, ...retained];

    const expectedSeqIds = plan.snapshotsByKey.get(step.childKey)
      .map(row => plan.survivorMap.get(row.id) ?? row.id);
    const plannedSeqIds = plannedRows.map(row => row.id);
    if (new Set(expectedSeqIds).size !== expectedSeqIds.length
      || expectedSeqIds.length !== plannedSeqIds.length
      || expectedSeqIds.some((id, index) => id !== plannedSeqIds[index])) {
      fail(
        'PLANNED_SEQ_ORDER_MISMATCH',
        `linking ${targetConversationId(step.childKey)} would change seq-first message order`,
      );
    }

    const expectedCreatedIds = plan.createdSnapshotsByKey.get(step.childKey)
      .map(row => plan.survivorMap.get(row.id) ?? row.id);
    const plannedCreatedIds = [...plannedRows]
      .sort((left, right) => (
        left.created_at.localeCompare(right.created_at)
        || left.plannedSeq - right.plannedSeq
        || left.storage_rowid - right.storage_rowid
      ))
      .map(row => row.id);
    if (expectedCreatedIds.length !== plannedCreatedIds.length
      || expectedCreatedIds.some((id, index) => id !== plannedCreatedIds[index])) {
      fail(
        'PLANNED_CREATED_ORDER_MISMATCH',
        `linking ${targetConversationId(step.childKey)} would change created_at-first message order`,
      );
    }
  }
}

function getVisibleMessages(db, conversationId, order = 'seq') {
  const chain = resolveChain(db, conversationId);
  const parts = [];
  const params = [];
  for (const segment of chain) {
    if (segment.seqEnd === null) {
      parts.push('conversation_id = ?');
      params.push(segment.conversationId);
    } else {
      parts.push('(conversation_id = ? AND seq <= ?)');
      params.push(segment.conversationId, segment.seqEnd);
    }
  }
  const orderSql = order === 'created'
    ? 'created_at ASC, seq ASC, rowid ASC'
    : 'seq ASC, rowid ASC';
  return db.prepare(`
    SELECT rowid AS storage_rowid, id, conversation_id, role, content,
           token_count, created_at, seq, metadata
    FROM messages
    WHERE (${parts.join(' OR ')})
    ORDER BY ${orderSql}
  `).all(...params);
}

function assertQuickCheck(db) {
  const rows = db.prepare('PRAGMA quick_check').all();
  if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') {
    fail('SQLITE_INTEGRITY', 'PRAGMA quick_check did not return ok');
  }
  const foreignKeyRows = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyRows.length > 0) {
    fail('FOREIGN_KEY_VIOLATION', `foreign_key_check returned ${foreignKeyRows.length} row(s)`);
  }
}

function validateFts(db) {
  const messageCount = countMessages(db);
  for (const table of ['messages_fts', 'messages_fts_trigram']) {
    if (!tableExists(db, table)) continue;
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count;
    if (count !== messageCount) {
      fail('FTS_MISMATCH', `${table} count ${count} does not match messages count ${messageCount}`);
    }
    const mismatch = db.prepare(`
      SELECT 1
      FROM ${quoteIdentifier(table)} AS fts
      LEFT JOIN messages AS m ON m.id = fts.id
      WHERE m.id IS NULL
         OR fts.rowid != m.rowid
         OR CAST(fts.seq AS INTEGER) != m.seq
         OR fts.conversation_id != m.conversation_id
      LIMIT 1
    `).get();
    if (mismatch) fail('FTS_MISMATCH', `${table} contains a stale or misaligned row`);
  }
}

function parseJsonArray(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('INVALID_REFERENCE_JSON', `${label} is not valid JSON`);
  }
  if (!Array.isArray(value)) fail('INVALID_REFERENCE_JSON', `${label} is not a JSON array`);
  return value.filter(item => typeof item === 'string');
}

function validateTargetReferenceClosure(db) {
  const existingMessageIds = new Set(db.prepare('SELECT id FROM messages').all().map(row => row.id));
  const targetConversationIds = Object.keys(targetConversations()).map(targetConversationId);
  const placeholders = targetConversationIds.map(() => '?').join(', ');

  let summaryReferenceCount = 0;
  const messageRows = db.prepare(`
    SELECT id, metadata
    FROM messages
    WHERE conversation_id IN (${placeholders})
  `).all(...targetConversationIds);
  for (const row of messageRows) {
    let metadata;
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      continue;
    }
    if (!metadata || typeof metadata !== 'object' || !Array.isArray(metadata.summarizedIds)) continue;
    for (const id of metadata.summarizedIds) {
      if (typeof id !== 'string') continue;
      summaryReferenceCount += 1;
      if (!existingMessageIds.has(id)) {
        fail('DANGLING_SUMMARY_REFERENCE', `target summary metadata references missing message ${id}`);
      }
    }
  }

  let memorySourceReferenceCount = 0;
  if (tableExists(db, 'memories')) {
    const memories = db.prepare(
      'SELECT id, source_msg_ids FROM memories WHERE character_id = ?',
    ).all(targetCharacterId());
    for (const row of memories) {
      for (const id of parseJsonArray(row.source_msg_ids, `memories.source_msg_ids row ${row.id}`)) {
        memorySourceReferenceCount += 1;
        if (!existingMessageIds.has(id)) {
          fail('DANGLING_MEMORY_REFERENCE', `target memory references missing message ${id}`);
        }
      }
    }
  }

  let taskReferenceCount = 0;
  let taskDanglingReferenceCount = 0;
  if (tableExists(db, 'memory_tasks')) {
    const tasks = db.prepare(`
      SELECT id, message_ids
      FROM memory_tasks
      WHERE conversation_id IN (${placeholders})
    `).all(...targetConversationIds);
    for (const row of tasks) {
      for (const id of parseJsonArray(row.message_ids, `memory_tasks.message_ids row ${row.id}`)) {
        taskReferenceCount += 1;
        if (!existingMessageIds.has(id)) {
          // Completed/failed tasks are historical audit rows. This database already contains a
          // few stale ids in completed root tasks, unrelated to the duplicate rows being removed.
          // Candidate-id closure is enforced separately; do not turn pre-existing task history
          // into a migration blocker or silently rewrite ids for which no survivor is known.
          taskDanglingReferenceCount += 1;
        }
      }
    }
  }

  return {
    summaryReferenceCount,
    memorySourceReferenceCount,
    taskReferenceCount,
    taskDanglingReferenceCount,
  };
}

function analyzePendingState(db, conversations) {
  assertNoInflightTargetWork(db);
  const snapshotsByKey = new Map();
  const createdSnapshotsByKey = new Map();
  for (const [key] of Object.entries(targetConversations())) {
    const conversationId = conversations.get(key).id;
    const seqRows = getMessages(db, conversationId, 'seq');
    assertUniqueIntegerSeq(seqRows, conversationId);
    snapshotsByKey.set(key, seqRows);
    createdSnapshotsByKey.set(key, getMessages(db, conversationId, 'created'));
  }
  assertContiguousSeq(snapshotsByKey.get('root'), 1, 'chain root');

  const directMap = new Map();
  const retainedByKey = new Map([['root', snapshotsByKey.get('root')]]);
  const prefixCounts = new Map();

  for (const step of linkSteps()) {
    const parentCreatedRows = createdSnapshotsByKey.get(step.parentKey);
    const childRows = snapshotsByKey.get(step.childKey);
    if (childRows.length < parentCreatedRows.length) {
      fail(
        'PREFIX_TOO_SHORT',
        `conversation ${targetConversationId(step.childKey)} has fewer rows than its parent copy`,
      );
    }
    const prefixRows = childRows.slice(0, parentCreatedRows.length);
    assertContiguousSeq(prefixRows, 1, `duplicate prefix ${targetConversationId(step.childKey)}`);
    for (let index = 0; index < parentCreatedRows.length; index += 1) {
      const differing = differingCopiedFields(parentCreatedRows[index], prefixRows[index]);
      if (differing.length > 0) {
        fail(
          'PREFIX_MISMATCH',
          `duplicate prefix mismatch for ${targetConversationId(step.childKey)} at ordinal ${index + 1}; fields: ${differing.join(',')}`,
        );
      }
      if (directMap.has(prefixRows[index].id)) {
        fail('DUPLICATE_CANDIDATE', 'a candidate message appeared in more than one prefix');
      }
      directMap.set(prefixRows[index].id, parentCreatedRows[index].id);
    }
    prefixCounts.set(step.childKey, prefixRows.length);
    retainedByKey.set(step.childKey, childRows.slice(prefixRows.length));
  }

  const survivorMap = composeSurvivorMap(directMap);
  const candidateIds = new Set(survivorMap.keys());
  const survivorIds = new Set(survivorMap.values());
  for (const id of candidateIds) {
    if (survivorIds.has(id)) {
      fail('MAPPING_OVERLAP', 'a deleted candidate was also selected as a final survivor');
    }
  }

  const allMessageIds = new Set(db.prepare('SELECT id FROM messages').all().map(row => row.id));
  for (const id of survivorIds) {
    if (!allMessageIds.has(id)) fail('MISSING_SURVIVOR', `mapped survivor is missing: ${id}`);
  }
  assertNoInflightTargetWork(db, candidateIds);

  const expectedBounds = new Map();
  const seqAssignments = [];
  let cumulative = retainedByKey.get('root').length;
  for (const step of linkSteps()) {
    expectedBounds.set(step.childKey, cumulative);
    const retained = retainedByKey.get(step.childKey);
    for (let index = 0; index < retained.length; index += 1) {
      seqAssignments.push({
        id: retained[index].id,
        conversationId: targetConversationId(step.childKey),
        oldSeq: retained[index].seq,
        newSeq: cumulative + index + 1,
      });
    }
    cumulative += retained.length;
  }

  const referenceAnalysis = analyzeJsonReferences(db, survivorMap);
  const globalMessageCountBefore = countMessages(db);
  const chainMessageCountBefore = countChainMessages(db);

  const plan = {
    state: 'pending',
    conversations,
    snapshotsByKey,
    createdSnapshotsByKey,
    retainedByKey,
    prefixCounts,
    survivorMap,
    candidateIds,
    survivorIds,
    expectedBounds,
    seqAssignments,
    referenceAnalysis,
    globalMessageCountBefore,
    globalMessageCountAfter: globalMessageCountBefore - candidateIds.size,
    chainMessageCountBefore,
    chainMessageCountAfter: chainMessageCountBefore - candidateIds.size,
    finalVisibleCount: cumulative,
  };
  // The historical full-copy route selected the parent by created_at/seq, then assigned the
  // child seq as i+1. Prefix equality must therefore use parent-created order versus child-seq
  // order. This second check proves that replacing those copies with parent rows also preserves
  // both public read orders; otherwise dry-run stops before claiming the plan is lossless.
  validatePlannedVisibleOrder(plan);
  plan.referenceClosureBefore = validateTargetReferenceClosure(db);
  validateFts(db);
  assertQuickCheck(db);
  return plan;
}

function analyzeLinkedState(db, conversations) {
  let cumulative = getMessages(db, targetConversationId('root'), 'seq').length;
  const rootRows = getMessages(db, targetConversationId('root'), 'seq');
  assertUniqueIntegerSeq(rootRows, targetConversationId('root'));
  assertContiguousSeq(rootRows, 1, 'linked chain root');

  const conversationSummary = [{
    id: targetConversationId('root'),
    title: targetConversation('root').title,
    parentId: null,
    parentSeqEnd: null,
    physicalMessages: rootRows.length,
    visibleMessages: rootRows.length,
  }];

  for (const step of linkSteps()) {
    const child = conversations.get(step.childKey);
    const expectedParentId = targetConversationId(step.parentKey);
    if (child.parent_id !== expectedParentId || child.parent_seq_end !== cumulative) {
      fail(
        'INVALID_LINKED_STATE',
        `conversation ${child.id} does not have the expected parent boundary ${cumulative}`,
      );
    }
    const ownRows = getMessages(db, child.id, 'seq');
    assertUniqueIntegerSeq(ownRows, child.id);
    assertContiguousSeq(ownRows, cumulative + 1, `linked tail ${child.id}`);
    cumulative += ownRows.length;
    const visible = getVisibleMessages(db, child.id, 'seq');
    assertContiguousSeq(visible, 1, `visible linked conversation ${child.id}`);
    if (visible.length !== cumulative) {
      fail('VISIBLE_COUNT_MISMATCH', `conversation ${child.id} has an unexpected visible count`);
    }
    conversationSummary.push({
      id: child.id,
      title: targetConversation(step.childKey).title,
      parentId: child.parent_id,
      parentSeqEnd: child.parent_seq_end,
      physicalMessages: ownRows.length,
      visibleMessages: visible.length,
    });
  }

  assertNoInflightTargetWork(db);
  const referenceClosure = validateTargetReferenceClosure(db);
  validateFts(db);
  assertQuickCheck(db);
  return {
    state: 'already_applied',
    conversations,
    conversationSummary,
    globalMessageCount: countMessages(db),
    chainMessageCount: countChainMessages(db),
    finalVisibleCount: cumulative,
    referenceClosure,
  };
}

function analyzeDatabase(db) {
  requireSchema(db);
  const conversations = getConversationRows(db);
  const state = detectState(conversations);
  return state === 'pending'
    ? analyzePendingState(db, conversations)
    : analyzeLinkedState(db, conversations);
}

function remapMetadataForComparison(raw, survivorMap) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const stats = {
    referenceCount: 0,
    candidateIds: new Set(),
    mappedIds: new Set(),
    paths: new Set(),
  };
  const remapped = remapJsonValue(parsed, survivorMap, stats);
  return stats.referenceCount > 0 ? JSON.stringify(remapped) : raw;
}

function validateAppliedPlan(db, plan) {
  const conversations = getConversationRows(db);
  analyzeLinkedState(db, conversations);

  const placeholders = [...plan.candidateIds].map(() => '?').join(', ');
  if (plan.candidateIds.size > 0) {
    const remaining = db.prepare(
      `SELECT COUNT(*) AS count FROM messages WHERE id IN (${placeholders})`,
    ).get(...plan.candidateIds).count;
    if (remaining !== 0) fail('CANDIDATE_REMAINS', `${remaining} deleted candidate row(s) remain`);
  }
  if (countMessages(db) !== plan.globalMessageCountAfter) {
    fail('COUNT_MISMATCH', 'global message count does not match the migration plan');
  }
  if (countChainMessages(db) !== plan.chainMessageCountAfter) {
    fail('COUNT_MISMATCH', 'chain message count does not match the migration plan');
  }

  const postReferenceAnalysis = analyzeJsonReferences(db, plan.survivorMap);
  if (postReferenceAnalysis.updates.length !== 0) {
    fail('REFERENCE_REMAINS', 'candidate message-id references remain after migration');
  }

  for (const [key] of Object.entries(targetConversations())) {
    const conversationId = plan.conversations.get(key).id;
    const beforeSeq = plan.snapshotsByKey.get(key);
    const actualSeq = getVisibleMessages(db, conversationId, 'seq');
    if (actualSeq.length !== beforeSeq.length) {
      fail('VISIBLE_COUNT_MISMATCH', `conversation ${conversationId} changed visible message count`);
    }
    for (let index = 0; index < beforeSeq.length; index += 1) {
      const expectedId = plan.survivorMap.get(beforeSeq[index].id) ?? beforeSeq[index].id;
      if (actualSeq[index].id !== expectedId) {
        fail('VISIBLE_ID_MISMATCH', `conversation ${conversationId} changed visible order at ordinal ${index + 1}`);
      }
      for (const field of ['role', 'content', 'token_count', 'created_at']) {
        if (actualSeq[index][field] !== beforeSeq[index][field]) {
          fail('VISIBLE_DATA_MISMATCH', `conversation ${conversationId} changed ${field} at ordinal ${index + 1}`);
        }
      }
      const expectedMetadata = remapMetadataForComparison(beforeSeq[index].metadata, plan.survivorMap);
      if (actualSeq[index].metadata !== expectedMetadata) {
        fail('VISIBLE_DATA_MISMATCH', `conversation ${conversationId} changed metadata at ordinal ${index + 1}`);
      }
    }

    const beforeCreatedIds = plan.createdSnapshotsByKey.get(key)
      .map(row => plan.survivorMap.get(row.id) ?? row.id);
    const actualCreatedIds = getVisibleMessages(db, conversationId, 'created').map(row => row.id);
    if (beforeCreatedIds.length !== actualCreatedIds.length
      || beforeCreatedIds.some((id, index) => id !== actualCreatedIds[index])) {
      fail('CREATED_ORDER_MISMATCH', `conversation ${conversationId} changed created_at-first order`);
    }
  }

  validateTargetReferenceClosure(db);
  validateFts(db);
  assertQuickCheck(db);
}

function chunked(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function applyPendingPlan(db, plan) {
  for (const update of plan.referenceAnalysis.updates) {
    const result = db.prepare(`
      UPDATE ${quoteIdentifier(update.table)}
      SET ${quoteIdentifier(update.column)} = ?
      WHERE rowid = ? AND ${quoteIdentifier(update.column)} = ?
    `).run(update.newValue, update.storageRowid, update.oldValue);
    if (result.changes !== 1) {
      fail('REFERENCE_UPDATE_RACE', `${update.table}.${update.column} changed during migration`);
    }
  }

  let deleted = 0;
  for (const ids of chunked([...plan.candidateIds], 400)) {
    const placeholders = ids.map(() => '?').join(', ');
    deleted += db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids).changes;
  }
  if (deleted !== plan.candidateIds.size) {
    fail('DELETE_COUNT_MISMATCH', `expected to delete ${plan.candidateIds.size} rows, deleted ${deleted}`);
  }

  const updateSeq = db.prepare('UPDATE messages SET seq = ? WHERE id = ? AND conversation_id = ?');
  for (const assignment of plan.seqAssignments) {
    const result = updateSeq.run(assignment.newSeq, assignment.id, assignment.conversationId);
    if (result.changes !== 1) fail('SEQ_UPDATE_MISMATCH', `failed to re-sequence message ${assignment.id}`);
  }

  const updateConversation = db.prepare(`
    UPDATE conversations
    SET parent_id = ?, parent_seq_end = ?
    WHERE id = ? AND parent_id IS NULL AND parent_seq_end IS NULL
  `);
  for (const step of linkSteps()) {
    const childId = targetConversationId(step.childKey);
    const result = updateConversation.run(
      targetConversationId(step.parentKey),
      plan.expectedBounds.get(step.childKey),
      childId,
    );
    if (result.changes !== 1) fail('CONVERSATION_UPDATE_MISMATCH', `failed to link ${childId}`);
  }

  validateAppliedPlan(db, plan);
}

function publicReferenceSummary(referenceAnalysis) {
  return referenceAnalysis.approved.map(field => ({
    field: `${field.table}.${field.column}`,
    present: field.present,
    documents: field.documentCount,
    references: field.referenceCount,
    malformedDocuments: field.malformedCount,
    paths: field.paths,
    distinctCandidates: field.distinctCandidateCount,
    distinctSurvivors: field.distinctSurvivorCount,
  }));
}

function publicPendingSummary(plan) {
  const conversations = [];
  const rootRows = plan.retainedByKey.get('root');
  conversations.push({
    id: targetConversationId('root'),
    title: targetConversation('root').title,
    parentIdAfter: null,
    parentSeqEndAfter: null,
    physicalBefore: rootRows.length,
    prefixRowsDeleted: 0,
    physicalAfter: rootRows.length,
    visibleAfter: rootRows.length,
  });
  let visible = rootRows.length;
  for (const step of linkSteps()) {
    const retained = plan.retainedByKey.get(step.childKey);
    visible += retained.length;
    conversations.push({
      id: targetConversationId(step.childKey),
      title: targetConversation(step.childKey).title,
      parentIdAfter: targetConversationId(step.parentKey),
      parentSeqEndAfter: plan.expectedBounds.get(step.childKey),
      physicalBefore: plan.snapshotsByKey.get(step.childKey).length,
      prefixRowsDeleted: plan.prefixCounts.get(step.childKey),
      physicalAfter: retained.length,
      visibleAfter: visible,
      seqAfter: retained.length > 0
        ? [plan.expectedBounds.get(step.childKey) + 1, visible]
        : null,
    });
  }
  return {
    state: 'pending',
    counts: {
      globalMessagesBefore: plan.globalMessageCountBefore,
      globalMessagesAfter: plan.globalMessageCountAfter,
      chainMessagesBefore: plan.chainMessageCountBefore,
      chainMessagesAfter: plan.chainMessageCountAfter,
      rowsDeleted: plan.candidateIds.size,
      finalVisibleMessages: plan.finalVisibleCount,
    },
    mapping: {
      deletedCandidateIds: plan.candidateIds.size,
      distinctSurvivorIds: plan.survivorIds.size,
      candidateSurvivorOverlap: 0,
    },
    conversations,
    jsonReferences: publicReferenceSummary(plan.referenceAnalysis),
    referenceClosureBefore: plan.referenceClosureBefore,
  };
}

function publicLinkedSummary(plan) {
  return {
    state: 'already_applied',
    counts: {
      globalMessages: plan.globalMessageCount,
      chainMessages: plan.chainMessageCount,
      finalVisibleMessages: plan.finalVisibleCount,
    },
    conversations: plan.conversationSummary,
    referenceClosure: plan.referenceClosure,
  };
}

function runMigrationOnDatabase(db, options = {}) {
  const apply = options.apply === true;
  const vacuum = options.vacuum === true;
  activeTargetSpec = normalizeTargetSpec(options.targetSpec);
  activeTargetContext = null;
  db.pragma('busy_timeout = 30000');
  db.pragma('foreign_keys = ON');

  let stateBefore;
  let applied = false;
  let analysis;
  if (apply) {
    const transaction = db.transaction(() => {
      const fresh = analyzeDatabase(db);
      stateBefore = fresh.state;
      if (fresh.state === 'already_applied') return fresh;
      applyPendingPlan(db, fresh);
      applied = true;
      return fresh;
    });
    analysis = transaction.immediate();
  } else {
    analysis = analyzeDatabase(db);
    stateBefore = analysis.state;
  }

  const pageSize = db.pragma('page_size', { simple: true });
  const pagesBeforeVacuum = db.pragma('page_count', { simple: true });
  const freelistBeforeVacuum = db.pragma('freelist_count', { simple: true });
  let vacuumError = null;
  if (vacuum) {
    assertQuickCheck(db);
    try {
      db.exec('VACUUM');
      assertQuickCheck(db);
      validateFts(db);
      // In WAL mode this releases any now-empty WAL after VACUUM when no reader pins it.
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      vacuumError = error instanceof Error ? error.message : String(error);
      if (applied) {
        fail(
          'VACUUM_FAILED_AFTER_APPLY',
          `logical migration is committed, but VACUUM failed: ${vacuumError}`,
        );
      }
      fail('VACUUM_FAILED', vacuumError);
    }
  }
  const pagesAfterVacuum = db.pragma('page_count', { simple: true });
  const freelistAfterVacuum = db.pragma('freelist_count', { simple: true });

  const current = (!apply && !vacuum) ? analysis : analyzeDatabase(db);
  return {
    migration: MIGRATION_ID,
    mode: apply ? (vacuum ? 'apply+vacuum' : 'apply') : (vacuum ? 'vacuum' : 'dry-run'),
    stateBefore,
    stateAfter: current.state,
    applied,
    vacuumed: vacuum,
    vacuumError,
    plan: analysis.state === 'pending' ? publicPendingSummary(analysis) : publicLinkedSummary(analysis),
    current: current.state === 'pending' ? publicPendingSummary(current) : publicLinkedSummary(current),
    storage: {
      pageSize,
      pagesBeforeVacuum,
      freelistBeforeVacuum,
      pagesAfterVacuum,
      freelistAfterVacuum,
    },
  };
}

function parseArgs(argv) {
  let dbPath = path.resolve(process.cwd(), 'data', 'lumimuse.db');
  let apply = false;
  let vacuum = false;
  let explicitDryRun = false;
  let help = false;
  let characterName = TARGET_CHARACTER_NAME;
  const chainTitles = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') explicitDryRun = true;
    else if (arg === '--vacuum') vacuum = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--db') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('INVALID_ARGUMENT', '--db requires a path');
      dbPath = path.resolve(value);
      index += 1;
    } else if (arg.startsWith('--db=')) {
      dbPath = path.resolve(arg.slice('--db='.length));
    } else if (arg === '--character') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('INVALID_ARGUMENT', '--character requires a name');
      characterName = value;
      index += 1;
    } else if (arg.startsWith('--character=')) {
      characterName = arg.slice('--character='.length);
    } else if (arg === '--chain-title') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('INVALID_ARGUMENT', '--chain-title requires a title');
      chainTitles.push(value);
      index += 1;
    } else if (arg.startsWith('--chain-title=')) {
      chainTitles.push(arg.slice('--chain-title='.length));
    } else {
      fail('INVALID_ARGUMENT', `unknown argument: ${arg}`);
    }
  }
  if (apply && explicitDryRun) fail('INVALID_ARGUMENT', '--apply and --dry-run cannot be combined');
  if (vacuum && explicitDryRun) {
    fail('INVALID_ARGUMENT', '--vacuum changes the database and cannot be combined with --dry-run');
  }
  const targetSpec = chainTitles.length > 0
    ? makeTargetSpec(characterName, chainTitles)
    : undefined;
  return { dbPath, apply, vacuum, help, targetSpec };
}

function usage() {
  return [
    'Usage: node scripts/migrate-linked-conversation-chain.cjs [options]',
    '',
    'Options:',
    '  --db <path>  SQLite database path (default: data/lumimuse.db)',
    '  --dry-run    Analyze only (default)',
    '  --apply      Apply the logical migration in one IMMEDIATE transaction',
    '  --vacuum     Reclaim free pages; independent and may be combined with --apply',
    '  --character <name>  Character name (default: 篠澤広)',
    '  --chain-title <title>  Ordered chain title; repeat for each segment',
    '  -h, --help   Show this help',
  ].join('\n');
}

function runMigration(options) {
  if (!fs.existsSync(options.dbPath)) {
    fail('DB_NOT_FOUND', `database does not exist: ${options.dbPath}`);
  }
  const Database = loadDatabaseConstructor();
  const writable = options.apply || options.vacuum;
  const beforeBytes = fs.statSync(options.dbPath).size;
  const db = new Database(options.dbPath, {
    readonly: !writable,
    fileMustExist: true,
  });
  try {
    const result = runMigrationOnDatabase(db, options);
    return {
      ...result,
      database: path.resolve(options.dbPath),
      storage: {
        ...result.storage,
        bytesBefore: beforeBytes,
        bytesAfter: fs.statSync(options.dbPath).size,
      },
    };
  } finally {
    db.close();
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const result = runMigration(options);
    // Deliberately emit only counts, ids, titles, and integrity facts. Never print message bodies.
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof MigrationError ? error.code : 'UNEXPECTED_ERROR';
    const message = error instanceof Error ? error.message : 'unknown failure';
    process.stderr.write(`${JSON.stringify({ migration: MIGRATION_ID, ok: false, code, error: message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MIGRATION_ID,
  TARGET_CHARACTER_NAME,
  TARGET_CONVERSATIONS: DEFAULT_TARGET_CONVERSATIONS,
  LINK_STEPS: DEFAULT_LINK_STEPS,
  makeTargetSpec,
  MigrationError,
  analyzeDatabase,
  parseArgs,
  runMigration,
  runMigrationOnDatabase,
};

if (require.main === module) main();
