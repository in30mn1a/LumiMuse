/**
 * 作品片单（works catalog）核心模块：归一化匹配、存取与确定性渲染。
 *
 * 片单是按角色存放的「用户看过 / 在看 / 想看哪些作品」清单，每轮聊天固定注入。
 * 与记忆分开存放：归档摘要、合并结果都会用全新 metadata，挂在记忆上的信息会被悄悄丢掉。
 *
 * 写入路径只有三条，都按字段写入，不让 LLM 整份重写：
 * - 自动更新（works-catalog-update.ts）：只增不删、不清空字段、不碰已移除条目；
 * - 主人在界面手动修改（/api/works）；
 * - 主人批准的内置 Agent 提案。
 *
 * 聊天链路会 import 本模块，所以这里不得 import `@/lib/agent/*`。
 */
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { WORK_TYPES, type WorkEntry, type WorkStatus, type WorkType } from '@/types';
import { parseStoredTimestamp } from '@/lib/memory-time-cutoff';
import {
  WORK_STATUS_LABELS,
  WORK_TYPE_LABELS,
  cleanWorkAliases,
  cleanWorkTitle,
  isUsableWorkTitle,
  isWorkStatus,
  isWorkType,
  mergeIdLists,
  normalizeWorkTitle,
} from '@/lib/works-catalog-text';

// 纯文本工具放在 works-catalog-text.ts（浏览器端也要用），这里原样转出，老的 import 路径不变。
export {
  WORK_FIELD_LIMITS,
  WORK_STATUS_LABELS,
  WORK_TYPE_LABELS,
  cleanWorkAliases,
  cleanWorkTitle,
  clipWorkText,
  isUsableWorkTitle,
  isWorkStatus,
  isWorkType,
  mergeIdLists,
  normalizeWorkTitle,
} from '@/lib/works-catalog-text';

/** 渲染与列表的排序：类型 → 状态 → first_seen_at → id。 */
const STATUS_ORDER: Record<WorkStatus, number> = { watching: 0, watched: 1, want: 2 };
const TYPE_ORDER: Record<WorkType, number> = { movie: 0, series: 1, book: 2, game: 3 };

export const WORKS_CATALOG_HEADING = '## 用户的作品清单';
const WORKS_CATALOG_USAGE = '这是用户看过、在看和想看的作品（书是读过、在读、想读，游戏是玩过、在玩、想玩），'
  + '由系统根据你们的对话整理。推荐新作品时，不要把已经看过、读过、玩过的作品当成新推荐；'
  + '可以优先从想看、想读、想玩的作品里挑。';

export class WorkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkValidationError';
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

type WorkRow = {
  id: string;
  character_id: string;
  work_type: string;
  title: string;
  aliases: string;
  status: string;
  rating: string;
  progress: string;
  note: string;
  source_memory_ids: string;
  source_msg_ids: string;
  first_seen_at: string;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** 行 → WorkEntry。类型或状态不认识的行（只可能来自手工改库或未来版本）返回 null。 */
export function parseWorkRow(row: WorkRow): WorkEntry | null {
  if (!isWorkType(row.work_type) || !isWorkStatus(row.status)) return null;
  return {
    id: row.id,
    character_id: row.character_id,
    work_type: row.work_type,
    title: row.title,
    aliases: parseStringArray(row.aliases),
    status: row.status,
    rating: row.rating ?? '',
    progress: row.progress ?? '',
    note: row.note ?? '',
    source_memory_ids: parseStringArray(row.source_memory_ids),
    source_msg_ids: parseStringArray(row.source_msg_ids),
    first_seen_at: row.first_seen_at,
    dismissed_at: row.dismissed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function compareWorks(a: WorkEntry, b: WorkEntry): number {
  return TYPE_ORDER[a.work_type] - TYPE_ORDER[b.work_type]
    || STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || (a.first_seen_at < b.first_seen_at ? -1 : a.first_seen_at > b.first_seen_at ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function listWorks(
  db: Database.Database,
  characterId: string,
  options: { includeDismissed?: boolean } = {},
): WorkEntry[] {
  const rows = db.prepare(
    options.includeDismissed
      ? 'SELECT * FROM character_works WHERE character_id = ?'
      : 'SELECT * FROM character_works WHERE character_id = ? AND dismissed_at IS NULL',
  ).all(characterId) as WorkRow[];
  return rows
    .map(parseWorkRow)
    .filter((entry): entry is WorkEntry => entry !== null)
    .sort(compareWorks);
}

export function getWork(db: Database.Database, id: string): WorkEntry | null {
  const row = db.prepare('SELECT * FROM character_works WHERE id = ?').get(id) as WorkRow | undefined;
  return row ? parseWorkRow(row) : null;
}

/**
 * 在同角色、同类型下按规范名和别名的归一化结果找已有条目，包括已移除的条目
 * （已移除条目要能被认出来，自动更新才不会把它加回）。
 * 同时命中时优先返回未移除的条目。
 */
export function findMatchingWork(
  db: Database.Database,
  characterId: string,
  workType: WorkType,
  names: readonly string[],
): WorkEntry | null {
  const keys = new Set(names.map(normalizeWorkTitle).filter(Boolean));
  if (keys.size === 0) return null;
  const rows = db.prepare('SELECT * FROM character_works WHERE character_id = ? AND work_type = ?')
    .all(characterId, workType) as WorkRow[];
  let dismissedMatch: WorkEntry | null = null;
  for (const entry of rows.map(parseWorkRow).filter((e): e is WorkEntry => e !== null).sort(compareWorks)) {
    const entryKeys = [entry.title, ...entry.aliases].map(normalizeWorkTitle);
    if (!entryKeys.some(key => keys.has(key))) continue;
    if (entry.dismissed_at === null) return entry;
    dismissedMatch ??= entry;
  }
  return dismissedMatch;
}

export interface WorkCreateInput {
  character_id: string;
  work_type: WorkType;
  title: string;
  aliases?: readonly string[];
  status: WorkStatus;
  rating?: string;
  progress?: string;
  note?: string;
  source_memory_ids?: readonly string[];
  source_msg_ids?: readonly string[];
  first_seen_at?: string;
}

function assertValidCreate(input: WorkCreateInput): void {
  if (!isWorkType(input.work_type)) throw new WorkValidationError(`不支持的作品类型：${String(input.work_type)}`);
  if (!isWorkStatus(input.status)) throw new WorkValidationError(`不支持的作品状态：${String(input.status)}`);
  if (!isUsableWorkTitle(input.title)) throw new WorkValidationError('作品名称不能为空');
}

/**
 * first_seen_at 能解析时统一存成 ISO（兼容 SQLite 的 "YYYY-MM-DD HH:MM:SS" UTC 格式）：
 * 列表按字符串排序，混用两种格式会排错。解析不了时原样保留。
 */
function normalizeFirstSeenAt(value: string): string {
  const ms = parseStoredTimestamp(value);
  return ms === null ? value : new Date(ms).toISOString();
}

export function createWork(db: Database.Database, input: WorkCreateInput, now: string): WorkEntry {
  assertValidCreate(input);
  const title = cleanWorkTitle(input.title);
  const id = crypto.randomUUID().slice(0, 12);
  db.prepare(`
    INSERT INTO character_works (
      id, character_id, work_type, title, aliases, status, rating, progress, note,
      source_memory_ids, source_msg_ids, first_seen_at, dismissed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    input.character_id,
    input.work_type,
    title,
    JSON.stringify(cleanWorkAliases(input.aliases ?? [], title)),
    input.status,
    (input.rating ?? '').trim(),
    (input.progress ?? '').trim(),
    (input.note ?? '').trim(),
    JSON.stringify(mergeIdLists(input.source_memory_ids ?? [])),
    JSON.stringify(mergeIdLists(input.source_msg_ids ?? [])),
    normalizeFirstSeenAt(input.first_seen_at || now),
    now,
    now,
  );
  const created = getWork(db, id);
  if (!created) throw new Error(`failed to create work ${id}`);
  return created;
}

export interface WorkUpdatePatch {
  work_type?: WorkType;
  title?: string;
  aliases?: readonly string[];
  status?: WorkStatus;
  rating?: string;
  progress?: string;
  note?: string;
  source_memory_ids?: readonly string[];
  source_msg_ids?: readonly string[];
  first_seen_at?: string;
  /** true = 移除（写入墓碑时间），false = 恢复 */
  dismissed?: boolean;
}

/**
 * 按给出的字段原样写入（主人手动修改和批准的提案用，允许清空）。
 * 自动更新的「只增不删、不清空」规则在 works-catalog-update.ts 里实现，不走这里的语义。
 */
export function updateWork(db: Database.Database, id: string, patch: WorkUpdatePatch, now: string): WorkEntry {
  const current = getWork(db, id);
  if (!current) throw new WorkValidationError(`片单条目不存在：${id}`);
  if (patch.work_type !== undefined && !isWorkType(patch.work_type)) {
    throw new WorkValidationError(`不支持的作品类型：${String(patch.work_type)}`);
  }
  if (patch.status !== undefined && !isWorkStatus(patch.status)) {
    throw new WorkValidationError(`不支持的作品状态：${String(patch.status)}`);
  }
  const title = patch.title !== undefined ? cleanWorkTitle(patch.title) : current.title;
  if (!isUsableWorkTitle(title)) throw new WorkValidationError('作品名称不能为空');
  const next: WorkEntry = {
    ...current,
    work_type: patch.work_type ?? current.work_type,
    title,
    aliases: cleanWorkAliases(patch.aliases ?? current.aliases, title),
    status: patch.status ?? current.status,
    rating: patch.rating !== undefined ? patch.rating.trim() : current.rating,
    progress: patch.progress !== undefined ? patch.progress.trim() : current.progress,
    note: patch.note !== undefined ? patch.note.trim() : current.note,
    source_memory_ids: patch.source_memory_ids !== undefined ? mergeIdLists(patch.source_memory_ids) : current.source_memory_ids,
    source_msg_ids: patch.source_msg_ids !== undefined ? mergeIdLists(patch.source_msg_ids) : current.source_msg_ids,
    first_seen_at: patch.first_seen_at ? normalizeFirstSeenAt(patch.first_seen_at) : current.first_seen_at,
    dismissed_at: patch.dismissed === undefined ? current.dismissed_at : patch.dismissed ? (current.dismissed_at ?? now) : null,
    updated_at: now,
  };
  db.prepare(`
    UPDATE character_works SET
      work_type = ?, title = ?, aliases = ?, status = ?, rating = ?, progress = ?, note = ?,
      source_memory_ids = ?, source_msg_ids = ?, first_seen_at = ?, dismissed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.work_type, next.title, JSON.stringify(next.aliases), next.status, next.rating, next.progress, next.note,
    JSON.stringify(next.source_memory_ids), JSON.stringify(next.source_msg_ids), next.first_seen_at,
    next.dismissed_at, next.updated_at, id,
  );
  const updated = getWork(db, id);
  if (!updated) throw new Error(`failed to update work ${id}`);
  return updated;
}

/** 硬删除一行（只给「撤销 Agent 新增条目」用；主人在界面上的「移除」是写墓碑）。 */
export function deleteWork(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM character_works WHERE id = ?').run(id).changes > 0;
}

/** 片单的历史截止：inclusive 与记忆的 MemoryTimeCutoff.inclusive 同义（插入回复含锚点时刻，重新生成严格早于）。 */
export interface WorksCatalogCutoffOptions {
  cutoff?: string;
  /** 默认 true：first_seen_at 等于截止时刻也算「之前」 */
  inclusive?: boolean;
}

function isWithinCutoff(value: string, cutoff: string, inclusive: boolean): boolean {
  // SQLite 的 "YYYY-MM-DD HH:MM:SS" 是 UTC，裸 Date.parse 会按本地时区读
  const a = parseStoredTimestamp(value);
  const b = parseStoredTimestamp(cutoff);
  // 时间解析不了时不藏条目：宁可多给，也不让片单悄悄缺一块。
  if (a === null || b === null) return true;
  return inclusive ? a <= b : a < b;
}

function filterByCutoff(entries: readonly WorkEntry[], options: WorksCatalogCutoffOptions): WorkEntry[] {
  const { cutoff, inclusive = true } = options;
  return cutoff ? entries.filter(entry => isWithinCutoff(entry.first_seen_at, cutoff, inclusive)) : entries.slice();
}

function renderWorkLine(entry: WorkEntry): string {
  const parts = [`${WORK_STATUS_LABELS[entry.work_type][entry.status]}：《${entry.title}》`];
  if (entry.aliases.length > 0) parts[0] += `（又名 ${entry.aliases.join(' / ')}）`;
  if (entry.rating) parts.push(`评分 ${entry.rating}`);
  if (entry.progress) parts.push(`进度 ${entry.progress}`);
  if (entry.note) parts.push(entry.note);
  return `- ${parts.join('｜')}`;
}

/**
 * 渲染片单文本。纯函数、确定性：同样的条目永远得到逐字节相同的文本。
 * 已移除条目不渲染；给了 cutoff 时只渲染 first_seen_at 在截止之前的条目（历史重新生成 / 插入回复用，
 * inclusive 决定等于截止时刻算不算之前）。
 * 没有可渲染的条目时返回空串，调用方据此一个字节都不加。
 */
export function renderWorksCatalog(entries: readonly WorkEntry[], options: WorksCatalogCutoffOptions = {}): string {
  const visible = filterByCutoff(entries, options)
    .filter(entry => entry.dismissed_at === null)
    .sort(compareWorks);
  if (visible.length === 0) return '';

  const sections: string[] = [WORKS_CATALOG_HEADING, WORKS_CATALOG_USAGE];
  for (const type of WORK_TYPES) {
    const lines = visible.filter(entry => entry.work_type === type).map(renderWorkLine);
    if (lines.length === 0) continue;
    sections.push(`### ${WORK_TYPE_LABELS[type]}\n${lines.join('\n')}`);
  }
  return sections.join('\n');
}

/** 聊天链路用：读取并渲染某角色的片单，同时给出渲染了多少条。 */
export function loadWorksCatalogText(
  db: Database.Database,
  characterId: string,
  options: WorksCatalogCutoffOptions = {},
): { text: string; count: number } {
  const visible = filterByCutoff(listWorks(db, characterId), options);
  return { text: renderWorksCatalog(visible), count: visible.length };
}
