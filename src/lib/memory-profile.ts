import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { chatCompletion, REASONING_SAFE_MAX_TOKENS } from '@/lib/api-client';
import { ensureMemoryProfileTables, getDb } from '@/lib/db';
import { buildBackgroundChatExtraBody, loadSettings, resolveBackgroundConfig } from '@/lib/settings';

export interface CharacterMemoryProfile {
  character_id: string;
  profile_name: string;
  relationship_state: string;
  recent_story_state: string;
  emotional_baseline: string;
  open_threads: string[];
  user_profile_summary: string;
  pinned_summary: string;
  updated_at: string;
}

export type MemoryProfilePatch = Partial<Pick<
  CharacterMemoryProfile,
  | 'profile_name'
  | 'relationship_state'
  | 'recent_story_state'
  | 'emotional_baseline'
  | 'open_threads'
  | 'user_profile_summary'
  | 'pinned_summary'
>>;

export interface MemoryProfileUpdateTask {
  id: number;
  character_id: string;
  reason: string;
  patch: MemoryProfilePatch;
  source_text: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  claim_token: string | null;
  lease_expires_at: string | null;
  retry_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export type MemoryProfileTaskSummary = Pick<
  MemoryProfileUpdateTask,
  | 'id'
  | 'character_id'
  | 'reason'
  | 'status'
  | 'retry_count'
  | 'error_message'
  | 'created_at'
  | 'updated_at'
>;

export interface MemoryProfileVersion {
  id: number;
  character_id: string;
  version_number: number;
  snapshot: CharacterMemoryProfile;
  reason: string;
  task_id: number | null;
  created_at: string;
}

export interface ProcessMemoryProfileUpdateResult {
  processed: number;
  skipped: number;
  failed: number;
  remaining: number;
  claimed: number;
  has_pending_tasks: boolean;
  no_pending_tasks: boolean;
  message: string;
  profiles: CharacterMemoryProfile[];
}

interface MemoryProfileRow {
  character_id: string;
  profile_name: string;
  relationship_state: string;
  recent_story_state: string;
  emotional_baseline: string;
  open_threads: string | string[];
  user_profile_summary: string;
  pinned_summary: string;
  updated_at: string;
}

interface MemoryProfileUpdateTaskRow {
  id: number;
  character_id: string;
  reason: string;
  patch_json: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  claim_token: string | null;
  lease_expires_at: string | null;
  retry_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

type MemoryProfileTaskSummaryRow = Omit<MemoryProfileUpdateTaskRow, 'patch_json' | 'claim_token' | 'lease_expires_at'>;

interface MemoryProfileVersionRow {
  id: number;
  character_id: string;
  version_number: number;
  snapshot_json: string;
  reason: string;
  task_id: number | null;
  created_at: string;
}

const PROFILE_CONTENT_FIELDS = [
  'relationship_state',
  'recent_story_state',
  'emotional_baseline',
  'open_threads',
  'user_profile_summary',
  'pinned_summary',
] as const;
const PATCH_FIELDS = [
  'profile_name',
  ...PROFILE_CONTENT_FIELDS,
] as const;
type MemoryProfilePatchField = typeof PATCH_FIELDS[number];
const MAX_MEMORY_PROFILE_VERSIONS = 100;

function boundedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function boundedOffset(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

interface MemoryProfilePatchExtractionPayload {
  source_text: string;
}

type MemoryProfilePatchGenerator = (
  task: MemoryProfileUpdateTask,
  currentProfile: CharacterMemoryProfile,
) => Promise<MemoryProfilePatch>;

function isExtractionPayload(value: unknown): value is MemoryProfilePatchExtractionPayload {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).source_text === 'string';
}

function parseOpenThreads(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeOpenThreads(value: string[]): string[] {
  return value
    .map(item => item.trim())
    .filter(Boolean);
}

function parseTaskPayload(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeTaskRow(row: MemoryProfileUpdateTaskRow): MemoryProfileUpdateTask {
  const payload = parseTaskPayload(row.patch_json);
  const sourceText = isExtractionPayload(payload) ? payload.source_text.trim() : '';
  return {
    ...row,
    patch: sourceText ? {} : normalizeStoredPatch(payload),
    source_text: sourceText,
  };
}

function normalizeTaskSummaryRow(row: MemoryProfileTaskSummaryRow): MemoryProfileTaskSummary {
  return {
    id: row.id,
    character_id: row.character_id,
    reason: row.reason,
    status: row.status,
    retry_count: row.retry_count,
    error_message: row.error_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeRow(row: MemoryProfileRow): CharacterMemoryProfile {
  return {
    ...row,
    profile_name: row.profile_name || '',
    relationship_state: row.relationship_state || '',
    recent_story_state: row.recent_story_state || '',
    emotional_baseline: row.emotional_baseline || '',
    open_threads: parseOpenThreads(row.open_threads),
    user_profile_summary: row.user_profile_summary || '',
    pinned_summary: row.pinned_summary || '',
  };
}

function normalizeVersionRow(row: MemoryProfileVersionRow): MemoryProfileVersion {
  return {
    ...row,
    snapshot: normalizeRow(JSON.parse(row.snapshot_json) as MemoryProfileRow),
  };
}

function normalizePatchPayload(
  value: unknown,
  options: { preserveEmpty: boolean; fields?: readonly MemoryProfilePatchField[] },
): MemoryProfilePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const record = value as Record<string, unknown>;
  const patch: MemoryProfilePatch = {};

  const fields = options.fields ?? PATCH_FIELDS;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const raw = record[field];

    if (field === 'open_threads') {
      const threads = Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        : [];
      if (threads.length > 0 || (options.preserveEmpty && Array.isArray(raw))) {
        patch.open_threads = [...new Set(threads)];
      }
      continue;
    }

    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text || options.preserveEmpty) patch[field] = text as never;
  }

  return patch;
}

function normalizeStoredPatch(value: unknown): MemoryProfilePatch {
  return normalizePatchPayload(value, { preserveEmpty: true });
}

function normalizeGeneratedPatch(value: unknown): MemoryProfilePatch {
  return normalizePatchPayload(value, { preserveEmpty: false, fields: PROFILE_CONTENT_FIELDS });
}

function hasPatchChanges(patch: MemoryProfilePatch): boolean {
  return PATCH_FIELDS.some(field => Object.prototype.hasOwnProperty.call(patch, field));
}

function hasProfileContent(profile: CharacterMemoryProfile): boolean {
  return PROFILE_CONTENT_FIELDS.some(field => {
    const value = profile[field];
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function findBalancedJsonSnippet(text: string, startIdx: number): string | null {
  const first = text[startIdx];
  if (first !== '{') return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }

  return null;
}

export function parseMemoryProfilePatchResponse(response: string): MemoryProfilePatch {
  let text = response.trim();
  if (text.startsWith('```')) text = text.split('\n').slice(1).join('\n');
  if (text.endsWith('```')) text = text.slice(0, text.lastIndexOf('```'));

  const parseError = (detail: string, cause?: unknown): Error => {
    const causeMessage = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
    return new Error(`memory profile patch parsing failed: ${detail}${causeMessage}`);
  };
  const normalizeParsedObject = (parsed: unknown): MemoryProfilePatch => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw parseError('response JSON must be an object');
    }
    const record = parsed as Record<string, unknown>;
    const root = Object.prototype.hasOwnProperty.call(record, 'patch') ? record.patch : parsed;
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      throw parseError('profile patch must be a JSON object');
    }
    return normalizeGeneratedPatch(root);
  };

  try {
    return normalizeParsedObject(JSON.parse(text));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const objectIdx = text.indexOf('{');
    if (objectIdx === -1) throw parseError('response did not contain a JSON object', error);
    const snippet = findBalancedJsonSnippet(text, objectIdx);
    if (!snippet) throw parseError('response did not contain a balanced JSON object', error);
    try {
      return normalizeParsedObject(JSON.parse(snippet));
    } catch (snippetError) {
      throw parseError('JSON object snippet could not be parsed', snippetError);
    }
  }
}

function buildMemoryProfilePatchPrompt(
  task: MemoryProfileUpdateTask,
  currentProfile: CharacterMemoryProfile,
  sourceText: string,
  characterInfo: string,
): string {
  return [
    '你是 LumiMuse 的记忆画像维护器。请根据新的长期记忆信号，生成一个只包含必要字段的 JSON patch。',
    '只能输出 JSON 对象，不要解释。',
    '允许字段：relationship_state, recent_story_state, emotional_baseline, open_threads, user_profile_summary, pinned_summary。',
    '字段含义：recent_story_state 是最近正在发生的故事/阶段状态；open_threads 是仍需继续跟进的近期话题或未完成事项。',
    '如果没有值得进入长期角色画像的信息，输出 {"patch":{}}。',
    '不要编造用户没有表达过的事实。旧画像与新信号冲突时，只更新能被新信号支持的字段。',
    '',
    characterInfo,
    `任务原因：${task.reason}`,
    `当前画像：${JSON.stringify(currentProfile)}`,
    `新信号：${sourceText}`,
    '',
    '输出格式：{"patch":{"relationship_state":"...","recent_story_state":"...","emotional_baseline":"...","open_threads":["..."],"user_profile_summary":"...","pinned_summary":"..."}}',
  ].join('\n');
}

async function generateMemoryProfilePatchWithLlm(
  task: MemoryProfileUpdateTask,
  currentProfile: CharacterMemoryProfile,
): Promise<MemoryProfilePatch> {
  const rawSourceText = task.source_text.trim();
  if (!rawSourceText) return task.patch;

  const loaded = loadSettings();
  const bgConfig = resolveBackgroundConfig(loaded);

  // 读取角色信息，让画像 patch LLM 知道角色是谁
  let characterInfo = '';
  try {
    const db = getDb();
    const charRow = db.prepare(
      'SELECT name, basic_info, personality, scenario, other_info FROM characters WHERE id = ?'
    ).get(task.character_id) as
      | { name: string; basic_info: string; personality: string; scenario: string; other_info: string }
      | undefined;
    if (charRow) {
      const parts: string[] = [`角色名称：${charRow.name}`];
      if (charRow.basic_info) parts.push(`基本信息：${charRow.basic_info}`);
      if (charRow.personality) parts.push(`性格：${charRow.personality}`);
      if (charRow.scenario) parts.push(`场景设定：${charRow.scenario}`);
      if (charRow.other_info) parts.push(`其他补充：${charRow.other_info}`);
      characterInfo = parts.join('\n');
    }
  } catch { /* 角色信息读取失败不阻塞画像更新 */ }

  const settings = {
    ...loaded,
    // 后台画像 patch 可使用独立供应商/模型；留空则回退主接口。画像 patch 需要结构化 JSON，故强制 json_mode。
    api_base: bgConfig.api_base,
    api_key: bgConfig.api_key,
    model: bgConfig.model,
    json_mode: true,
    streaming: false,
    max_tokens: Math.max(loaded.max_tokens || 0, REASONING_SAFE_MAX_TOKENS),
  };
  if (!settings.api_base.trim() || !settings.model.trim()) {
    throw new Error('LLM provider is not configured for memory profile patch generation');
  }

  const prompt = buildMemoryProfilePatchPrompt(task, currentProfile, rawSourceText, characterInfo);
  const backgroundExtraBody = buildBackgroundChatExtraBody(loaded, settings.model);
  const response = await chatCompletion(settings, [{ role: 'user', content: prompt }], undefined, backgroundExtraBody);
  return parseMemoryProfilePatchResponse(response);
}

function selectProfile(characterId: string, db: Database.Database): CharacterMemoryProfile | null {
  const row = db
    .prepare('SELECT * FROM character_memory_profiles WHERE character_id = ?')
    .get(characterId) as MemoryProfileRow | undefined;
  return row ? normalizeRow(row) : null;
}

export function getOrCreateMemoryProfile(
  characterId: string,
  db: Database.Database = getDb(),
): CharacterMemoryProfile {
  ensureMemoryProfileTables(db);

  const existing = selectProfile(characterId, db);
  if (existing) return existing;

  db.prepare(`
    INSERT INTO character_memory_profiles (character_id, updated_at)
    VALUES (?, datetime('now'))
  `).run(characterId);

  const created = selectProfile(characterId, db);
  if (!created) {
    throw new Error(`failed to initialize memory profile for character ${characterId}`);
  }
  return created;
}

export function readMemoryProfile(
  characterId: string,
  db: Database.Database = getDb(),
): CharacterMemoryProfile | null {
  ensureMemoryProfileTables(db);
  return selectProfile(characterId, db);
}

export function patchMemoryProfile(
  characterId: string,
  patch: MemoryProfilePatch,
  db: Database.Database = getDb(),
): CharacterMemoryProfile {
  getOrCreateMemoryProfile(characterId, db);

  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const field of PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = patch[field];
    if (value === undefined) continue;

    assignments.push(`${field} = ?`);
    values.push(field === 'open_threads'
      ? JSON.stringify(normalizeOpenThreads(value as string[]))
      : String(value));
  }

  if (assignments.length > 0) {
    db.prepare(`
      UPDATE character_memory_profiles
      SET ${assignments.join(', ')}, updated_at = datetime('now')
      WHERE character_id = ?
    `).run(...values, characterId);
  }

  return getOrCreateMemoryProfile(characterId, db);
}

export function createMemoryProfileVersion(
  characterId: string,
  reason = 'profile_update',
  taskId?: number,
  db: Database.Database = getDb(),
): MemoryProfileVersion {
  ensureMemoryProfileTables(db);
  const profile = getOrCreateMemoryProfile(characterId, db);
  const nextVersion = ((db.prepare(`
    SELECT MAX(version_number) as version_number
    FROM character_memory_profile_versions
    WHERE character_id = ?
  `).get(characterId) as { version_number: number | null }).version_number ?? 0) + 1;

  const result = db.prepare(`
    INSERT INTO character_memory_profile_versions (
      character_id, version_number, snapshot_json, reason, task_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(characterId, nextVersion, JSON.stringify(profile), reason, taskId ?? null);

  const row = db
    .prepare('SELECT * FROM character_memory_profile_versions WHERE id = ?')
    .get(result.lastInsertRowid) as MemoryProfileVersionRow | undefined;
  if (!row) throw new Error(`failed to create memory profile version for character ${characterId}`);
  db.prepare(`
    DELETE FROM character_memory_profile_versions
    WHERE character_id = ?
      AND id NOT IN (
        SELECT id FROM character_memory_profile_versions
        WHERE character_id = ?
        ORDER BY version_number DESC
        LIMIT ?
      )
  `).run(characterId, characterId, MAX_MEMORY_PROFILE_VERSIONS);
  return normalizeVersionRow(row);
}

export function getMemoryProfileVersions(
  characterId: string,
  db: Database.Database = getDb(),
  options: { limit?: number; offset?: number } = {},
): MemoryProfileVersion[] {
  ensureMemoryProfileTables(db);
  const limit = boundedLimit(options.limit, 50, MAX_MEMORY_PROFILE_VERSIONS);
  const offset = boundedOffset(options.offset);
  return (db.prepare(`
    SELECT * FROM character_memory_profile_versions
    WHERE character_id = ?
    ORDER BY version_number DESC
    LIMIT ? OFFSET ?
  `).all(characterId, limit, offset) as MemoryProfileVersionRow[]).map(normalizeVersionRow);
}

export function deleteMemoryProfileVersion(
  characterId: string,
  versionId: number,
  db: Database.Database = getDb(),
): boolean {
  ensureMemoryProfileTables(db);
  const result = db.prepare(`
    DELETE FROM character_memory_profile_versions
    WHERE id = ? AND character_id = ?
  `).run(versionId, characterId);
  return result.changes > 0;
}

export function enqueueMemoryProfileUpdate(
  characterId: string,
  patch: MemoryProfilePatch,
  reason = 'memory_extraction',
  db: Database.Database = getDb(),
): MemoryProfileUpdateTask {
  ensureMemoryProfileTables(db);
  const result = db.prepare(`
    INSERT INTO character_memory_profile_update_tasks (
      character_id, reason, patch_json, status, retry_count, created_at, updated_at
    )
    VALUES (?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))
  `).run(characterId, reason, JSON.stringify(patch));

  const row = db
    .prepare('SELECT * FROM character_memory_profile_update_tasks WHERE id = ?')
    .get(result.lastInsertRowid) as MemoryProfileUpdateTaskRow | undefined;
  if (!row) throw new Error(`failed to enqueue memory profile update for character ${characterId}`);
  return normalizeTaskRow(row);
}

export function enqueueMemoryProfilePatchExtraction(
  characterId: string,
  sourceText: string,
  reason = 'memory_extraction',
  db: Database.Database = getDb(),
): MemoryProfileUpdateTask {
  ensureMemoryProfileTables(db);
  const result = db.prepare(`
    INSERT INTO character_memory_profile_update_tasks (
      character_id, reason, patch_json, status, retry_count, created_at, updated_at
    )
    VALUES (?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))
  `).run(characterId, reason, JSON.stringify({ source_text: sourceText }));

  const row = db
    .prepare('SELECT * FROM character_memory_profile_update_tasks WHERE id = ?')
    .get(result.lastInsertRowid) as MemoryProfileUpdateTaskRow | undefined;
  if (!row) throw new Error(`failed to enqueue memory profile patch extraction for character ${characterId}`);
  return normalizeTaskRow(row);
}

export function getMemoryProfileUpdateTasks(
  characterId: string,
  db: Database.Database = getDb(),
): MemoryProfileUpdateTask[] {
  ensureMemoryProfileTables(db);
  return (db.prepare(`
    SELECT * FROM character_memory_profile_update_tasks
    WHERE character_id = ?
    ORDER BY id ASC
  `).all(characterId) as MemoryProfileUpdateTaskRow[]).map(normalizeTaskRow);
}

export function getMemoryProfileTaskSummaries(
  characterId: string,
  db: Database.Database = getDb(),
): MemoryProfileTaskSummary[] {
  ensureMemoryProfileTables(db);
  return (db.prepare(`
    SELECT id, character_id, reason, status, retry_count, error_message, created_at, updated_at
    FROM character_memory_profile_update_tasks
    WHERE character_id = ?
    ORDER BY id ASC
  `).all(characterId) as MemoryProfileTaskSummaryRow[]).map(normalizeTaskSummaryRow);
}

function claimMemoryProfileUpdateTasks(
  db: Database.Database,
  limit: number,
  leaseSeconds: number,
  options: { taskId?: number; throughTaskId?: number; characterId?: string } = {},
): MemoryProfileUpdateTask[] {
  const claimToken = randomUUID();

  db.transaction(() => {
    const claimableFilter = `(
        status = 'pending'
        OR (
          status = 'processing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= datetime('now')
        )
      )`;
    const params: unknown[] = [];
    const filters = [claimableFilter];
    let limitSql = 'LIMIT ?';
    if (options.characterId) {
      filters.push('character_id = ?');
      params.push(options.characterId);
    }
    if (Number.isInteger(options.taskId)) {
      filters.push('id = ?');
      params.push(options.taskId);
    } else if (Number.isInteger(options.throughTaskId)) {
      filters.push('id <= ?');
      params.push(options.throughTaskId);
      limitSql = '';
    }
    const rows = db.prepare(`
      SELECT id FROM character_memory_profile_update_tasks
      WHERE ${filters.join(' AND ')}
      ORDER BY id ASC
      ${limitSql}
    `).all(...params, ...(limitSql ? [limit] : [])) as Array<{ id: number }>;

    for (const row of rows) {
      db.prepare(`
        UPDATE character_memory_profile_update_tasks
        SET status = 'processing',
            claim_token = ?,
            lease_expires_at = datetime('now', ?),
            error_message = NULL,
            updated_at = datetime('now')
        WHERE id = ?
          AND (
            status = 'pending'
            OR (
              status = 'processing'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= datetime('now')
            )
          )
      `).run(claimToken, `+${leaseSeconds} seconds`, row.id);
    }
  })();

  return (db.prepare(`
    SELECT * FROM character_memory_profile_update_tasks
    WHERE claim_token = ?
    ORDER BY id ASC
  `).all(claimToken) as MemoryProfileUpdateTaskRow[]).map(normalizeTaskRow);
}

function countClaimableMemoryProfileUpdateTasks(db: Database.Database, characterId?: string): number {
  const characterFilter = characterId ? 'AND character_id = ?' : '';
  return (db.prepare(`
    SELECT COUNT(*) as count FROM character_memory_profile_update_tasks
    WHERE (
        status = 'pending'
      OR (
        status = 'processing'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= datetime('now')
      )
    )
    ${characterFilter}
  `).get(...(characterId ? [characterId] : [])) as { count: number }).count;
}

function confirmTaskClaimForWrite(db: Database.Database, task: MemoryProfileUpdateTask): boolean {
  const result = db.prepare(`
    UPDATE character_memory_profile_update_tasks
    SET lease_expires_at = lease_expires_at
    WHERE id = ? AND claim_token = ? AND status = 'processing'
  `).run(task.id, task.claim_token);
  return result.changes > 0;
}

export async function processMemoryProfileUpdateTasks(options: {
  db?: Database.Database;
  limit?: number;
  leaseSeconds?: number;
  generatePatch?: MemoryProfilePatchGenerator;
  taskId?: number;
  throughTaskId?: number;
  characterId?: string;
} = {}): Promise<ProcessMemoryProfileUpdateResult> {
  const db = options.db || getDb();
  ensureMemoryProfileTables(db);
  const limit = Math.max(1, Math.floor(options.limit ?? 10));
  const leaseSeconds = Math.max(1, Math.floor(options.leaseSeconds ?? 300));
  const tasks = claimMemoryProfileUpdateTasks(db, limit, leaseSeconds, {
    taskId: options.taskId,
    throughTaskId: options.throughTaskId,
    characterId: options.characterId,
  });

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const profiles: CharacterMemoryProfile[] = [];

  for (const task of tasks) {
    try {
      const currentProfile = getOrCreateMemoryProfile(task.character_id, db);
      const generatePatch = options.generatePatch || generateMemoryProfilePatchWithLlm;
      const patch = task.source_text
        ? normalizeGeneratedPatch(await generatePatch(task, currentProfile))
        : task.patch;

      if (!hasPatchChanges(patch)) {
        const result = db.transaction(() => {
          if (!confirmTaskClaimForWrite(db, task)) {
            return { applied: false, profile: getOrCreateMemoryProfile(task.character_id, db) };
          }

          db.prepare(`
            UPDATE character_memory_profile_update_tasks
            SET status = 'done',
                claim_token = NULL,
                lease_expires_at = NULL,
                error_message = ?,
                updated_at = datetime('now')
            WHERE id = ? AND claim_token = ?
          `).run('empty profile patch skipped', task.id, task.claim_token);
          return { applied: true, profile: getOrCreateMemoryProfile(task.character_id, db) };
        })();
        skipped += 1;
        profiles.push(result.profile);
        continue;
      }

      const result = db.transaction(() => {
        if (!confirmTaskClaimForWrite(db, task)) {
          return { applied: false, profile: getOrCreateMemoryProfile(task.character_id, db) };
        }

        const updated = patchMemoryProfile(task.character_id, patch, db);
        createMemoryProfileVersion(task.character_id, task.reason, task.id, db);
        db.prepare(`
          UPDATE character_memory_profile_update_tasks
          SET status = 'done',
              claim_token = NULL,
              lease_expires_at = NULL,
              error_message = NULL,
              updated_at = datetime('now')
          WHERE id = ? AND claim_token = ?
        `).run(task.id, task.claim_token);
        return { applied: true, profile: updated };
      })();
      if (result.applied) {
        processed += 1;
      } else {
        skipped += 1;
      }
      profiles.push(result.profile);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(`
        UPDATE character_memory_profile_update_tasks
        SET status = 'failed',
            claim_token = NULL,
            lease_expires_at = NULL,
            retry_count = retry_count + 1,
            error_message = ?,
            updated_at = datetime('now')
        WHERE id = ? AND claim_token = ?
      `).run(message, task.id, task.claim_token);
    }
  }

  const remaining = countClaimableMemoryProfileUpdateTasks(db, options.characterId);
  return {
    processed,
    skipped,
    failed,
    remaining,
    claimed: tasks.length,
    has_pending_tasks: remaining > 0,
    no_pending_tasks: tasks.length === 0,
    message: tasks.length === 0 ? 'no pending tasks' : 'processed memory profile tasks',
    profiles,
  };
}

// ── 画像更新队列的后台驱动（与 memory-queue.ts 的 triggerQueue / recoverStaleTasks 对称）──
// 画像 patch 生成是较慢的后台 LLM 调用，必须异步排空、不阻塞调用方（提取队列 / 启动流程）。
let profileQueueProcessing = false;

/**
 * 触发画像更新队列处理：异步循环排空队列，不阻塞调用方。若已在处理则直接返回
 * （处理中新入队的任务会被同一循环的后续轮次领取；极端竞态下也由下次触发兜底）。
 */
export function triggerMemoryProfileQueue(): void {
  if (profileQueueProcessing) return;
  profileQueueProcessing = true;
  void (async () => {
    try {
      // 持续处理直到没有可领取的任务；上限保护避免异常情况下死循环。
      for (let i = 0; i < 1000; i += 1) {
        const result = await processMemoryProfileUpdateTasks({ limit: 5 });
        if (result.claimed === 0) break;
      }
    } catch (err) {
      console.error('[memory-profile] profile queue processing failed:', err);
    } finally {
      profileQueueProcessing = false;
    }
  })();
}

/** 服务启动时调用：仅回收租约已过期或缺失的 processing 画像任务，不抢另一实例 in-flight 任务。 */
export function recoverStaleMemoryProfileTasks(db: Database.Database = getDb()): void {
  ensureMemoryProfileTables(db);
  db.prepare(`
    UPDATE character_memory_profile_update_tasks
    SET status = 'pending', claim_token = NULL, lease_expires_at = NULL, updated_at = datetime('now')
    WHERE status = 'processing'
      AND (
        lease_expires_at IS NULL
        OR lease_expires_at <= datetime('now')
      )
  `).run();
}

export function rollbackMemoryProfile(
  characterId: string,
  versionId: number,
  db: Database.Database = getDb(),
): CharacterMemoryProfile {
  ensureMemoryProfileTables(db);
  const row = db.prepare(`
    SELECT * FROM character_memory_profile_versions
    WHERE id = ? AND character_id = ?
  `).get(versionId, characterId) as MemoryProfileVersionRow | undefined;
  if (!row) throw new Error(`memory profile version ${versionId} not found for character ${characterId}`);

  const version = normalizeVersionRow(row);
  return db.transaction(() => {
    if (!hasProfileContent(version.snapshot)) {
      return getOrCreateMemoryProfile(characterId, db);
    }
    return patchMemoryProfile(characterId, {
      profile_name: version.snapshot.profile_name,
      relationship_state: version.snapshot.relationship_state,
      recent_story_state: version.snapshot.recent_story_state,
      emotional_baseline: version.snapshot.emotional_baseline,
      open_threads: version.snapshot.open_threads,
      user_profile_summary: version.snapshot.user_profile_summary,
      pinned_summary: version.snapshot.pinned_summary,
    }, db);
  })();
}

export function renderMemoryProfile(profile: CharacterMemoryProfile): string {
  const lines = [
    profile.relationship_state.trim() ? `关系状态：${profile.relationship_state.trim()}` : '',
    profile.recent_story_state.trim() ? `近期故事状态：${profile.recent_story_state.trim()}` : '',
    profile.emotional_baseline.trim() ? `情绪基线：${profile.emotional_baseline.trim()}` : '',
    profile.open_threads.length > 0 ? `进行中的话题：${profile.open_threads.join('；')}` : '',
    profile.user_profile_summary.trim() ? `主人画像：${profile.user_profile_summary.trim()}` : '',
    profile.pinned_summary.trim() ? `置顶摘要：${profile.pinned_summary.trim()}` : '',
  ].filter(Boolean);

  if (lines.length === 0) return '';
  return ['记忆画像：', ...lines].join('\n');
}
