/**
 * 作品片单的自动更新：记忆提取产生结果后入队，后台模型读「当前片单 + 本轮对话」，
 * 输出逐条的新增或更新，程序按固定规则合并。
 *
 * 合并规则（applyWorksUpdate，整批一个事务）：
 * - 只增不删：没有删除、移除、合并这几种操作；
 * - 不清空：评分、进度、印象只在给了非空值时覆盖；
 * - 不碰已移除条目：命中墓碑就跳过，也不会因为同名再加回；
 * - 规范名不变：模型给的不同叫法进别名；
 * - 自动路径不把「看过」改回「在看 / 想看」：晚到的旧批次、重看都不降级；
 * - 目标优先用模型回传的 ref（W1..Wn），但 ref 指向的条目必须和本项共享至少一个名称；
 *   越界、指向别的角色或名称对不上时退回名称匹配，同提取阶段二 target 的兜底思路。
 *
 * 失败不阻塞：失败的任务按顺序退避重试，用完 WORKS_UPDATE_MAX_ATTEMPTS 次后标记失败并写结构化日志；
 * 不写提取候选表，不影响提取和聊天。
 */
import type Database from 'better-sqlite3';
import { chatCompletion, REASONING_SAFE_MAX_TOKENS } from '@/lib/api-client';
import { getDb } from '@/lib/db';
import { createDbTaskQueue } from '@/lib/db-task-queue';
import { applyBackgroundSystemPrompt } from '@/lib/background-system-prompt';
import { loadCharacterTaskModels, resolveCharacterTaskSystemPrompt } from '@/lib/character-task-models';
import { buildBackgroundChatExtraBody, loadSettings, mergeSettingsForBackgroundLlm, resolveBackgroundConfig } from '@/lib/settings';
import { runWithBackgroundLlmDeadline } from '@/lib/background-llm-deadline';
import { structuredLog } from '@/lib/structured-log';
import { extractBalancedJsonAt } from '@/lib/balanced-json';
import { WORKS_CATALOG_UPDATE_PROMPT } from '@/lib/prompt-templates';
import {
  WORK_FIELD_LIMITS,
  cleanWorkAliases,
  cleanWorkTitle,
  clipWorkText,
  createWork,
  findMatchingWork,
  getWork,
  isUsableWorkTitle,
  isWorkStatus,
  isWorkType,
  listWorks,
  mergeIdLists,
  normalizeWorkTitle,
  updateWork,
  type WorkUpdatePatch,
} from '@/lib/works-catalog';
import type { WorkEntry, WorkStatus, WorkType } from '@/types';

/** 片单更新任务队列：租约/认领/完成走统一 DbTaskQueue，参数照搬画像队列（不去重，按序处理） */
const worksTaskQueue = createDbTaskQueue({
  table: 'character_works_update_tasks',
  timestampMode: 'sqlite_now',
});

// ── 解析 ──

/** 模型输出的一项（只做形状归一，合法性在 applyWorksUpdate 里校验）。 */
export interface WorksUpdateItem {
  /** 规范化后的编号（如 "W3"）；模型没给或给的不是编号时为 null */
  ref: string | null;
  type: string;
  title: string;
  aliases: string[];
  status: string;
  rating: string;
  progress: string;
  note: string;
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  // 评分常被模型写成数字（9.5），按原样转成文本
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function normalizeRef(value: unknown): string | null {
  const text = toText(value).toUpperCase().replace(/\s+/g, '');
  const match = text.match(/^W?(\d+)$/);
  return match ? `W${Number(match[1])}` : null;
}

function normalizeAliases(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(toText).filter(Boolean);
  const single = toText(value);
  return single ? [single] : [];
}

function normalizeResponseItem(value: unknown): WorksUpdateItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    ref: normalizeRef(record.ref),
    type: toText(record.type).toLowerCase(),
    title: toText(record.title),
    aliases: normalizeAliases(record.aliases),
    status: toText(record.status).toLowerCase(),
    rating: toText(record.rating),
    progress: toText(record.progress),
    note: toText(record.note),
  };
}

function readWorksArray(parsed: unknown): unknown[] | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const works = (parsed as Record<string, unknown>).works;
  return Array.isArray(works) ? works : null;
}

/**
 * 解析 `{"works":[...]}`。容忍代码块包裹和前后杂文；找不到合法的 works 数组时抛错
 * （任务进入失败，片单不动）。单项形状不对的直接略过。
 */
export function parseWorksUpdateResponse(response: string): WorksUpdateItem[] {
  let text = response.trim();
  if (text.startsWith('```')) text = text.split('\n').slice(1).join('\n');
  if (text.endsWith('```')) text = text.slice(0, text.lastIndexOf('```'));
  text = text.trim();

  let works: unknown[] | null = null;
  try {
    works = readWorksArray(JSON.parse(text));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // 前后有杂文：逐个 `{` 尝试截取平衡的 JSON 对象，取第一个带 works 数组的。
    // 扫原始响应而不是去掉代码块后的文本：单行代码块（```json {...} ```）去围栏时整行都会被丢掉。
    for (let index = response.indexOf('{'); index !== -1 && works === null; index = response.indexOf('{', index + 1)) {
      const snippet = extractBalancedJsonAt(response, index);
      if (!snippet) continue;
      try {
        works = readWorksArray(JSON.parse(snippet));
      } catch {
        // 这一段不是合法 JSON，继续找下一个
      }
    }
  }
  if (works === null) {
    throw new Error('works catalog update parsing failed: response did not contain a {"works": [...]} object');
  }
  return works.map(normalizeResponseItem).filter((item): item is WorksUpdateItem => item !== null);
}

// ── 合并 ──

export interface WorksUpdateApplyOptions {
  /** 本批对话的消息 id，并入条目的 source_msg_ids */
  sourceMsgIds: readonly string[];
  /** 本批最后一条消息的时间，新条目的 first_seen_at；缺失时用 now */
  sourceTime: string | null;
  now: string;
  /** 仅用于日志 */
  taskId?: number;
}

export interface WorksUpdateApplyResult {
  created: string[];
  updated: string[];
  skippedDismissed: number;
  dropped: number;
}

interface ValidItem {
  ref: string | null;
  type: WorkType;
  title: string;
  aliases: string[];
  /** null = 模型没给状态（只允许用于更新已有条目） */
  status: WorkStatus | null;
  rating: string;
  progress: string;
  note: string;
}

/** 校验并截断。类型不合法、状态给了但不合法、名称不可用的项返回 null（丢弃）。 */
function validateItem(item: WorksUpdateItem): ValidItem | null {
  if (!isWorkType(item.type)) return null;
  if (item.status && !isWorkStatus(item.status)) return null;
  const title = clipWorkText(cleanWorkTitle(item.title), WORK_FIELD_LIMITS.title);
  if (!isUsableWorkTitle(title)) return null;
  const aliases = cleanWorkAliases(
    item.aliases.map(alias => clipWorkText(cleanWorkTitle(alias), WORK_FIELD_LIMITS.alias)),
    title,
  ).slice(0, WORK_FIELD_LIMITS.aliases);
  return {
    ref: item.ref,
    type: item.type,
    title,
    aliases,
    status: item.status ? item.status as WorkStatus : null,
    rating: clipWorkText(item.rating, WORK_FIELD_LIMITS.rating),
    progress: clipWorkText(item.progress, WORK_FIELD_LIMITS.progress),
    note: clipWorkText(item.note, WORK_FIELD_LIMITS.note),
  };
}

function sharesName(entry: WorkEntry, item: ValidItem): boolean {
  const entryKeys = new Set([entry.title, ...entry.aliases].map(normalizeWorkTitle));
  return [item.title, ...item.aliases].some(name => entryKeys.has(normalizeWorkTitle(name)));
}

/**
 * 确定目标条目：ref 指向的条目与本项共享至少一个名称（规范名或别名归一化后相同）才用它，
 * 类型可以不同（模型偶尔把电影写成剧集）；否则视为指错，退回名称匹配（含已移除条目）。
 * 只看类型会让 {ref: 黑镜, title: 西部世界} 改写黑镜的状态并把「西部世界」并进别名，
 * 西部世界若是已移除条目还会借此绕过墓碑。
 */
function resolveTarget(
  db: Database.Database,
  characterId: string,
  item: ValidItem,
  refMap: Readonly<Record<string, string>>,
): WorkEntry | null {
  const refId = item.ref && Object.prototype.hasOwnProperty.call(refMap, item.ref) ? refMap[item.ref] : undefined;
  if (refId) {
    const entry = getWork(db, refId);
    if (entry && entry.character_id === characterId && sharesName(entry, item)) return entry;
  }
  return findMatchingWork(db, characterId, item.type, [item.title, ...item.aliases]);
}

/** 自动路径的更新补丁：只含允许的字段；没有任何变化时返回 null（不碰 updated_at）。 */
function buildAutoPatch(target: WorkEntry, item: ValidItem, sourceMsgIds: readonly string[]): WorkUpdatePatch | null {
  const patch: WorkUpdatePatch = {};
  // 看过的作品不降级：晚到的旧批次可能带着「想看」，重看、想再看也仍算看过；在看 → 想看照常允许
  if (item.status && item.status !== target.status && target.status !== 'watched') patch.status = item.status;
  // 只用非空值覆盖，从不清空
  if (item.rating && item.rating !== target.rating) patch.rating = item.rating;
  if (item.progress && item.progress !== target.progress) patch.progress = item.progress;
  if (item.note && item.note !== target.note) patch.note = item.note;

  // 规范名不变，模型给的名称与别名并入别名；已有别名在前，只截掉超出上限的新叫法
  const aliasLimit = Math.max(WORK_FIELD_LIMITS.aliases, target.aliases.length);
  const aliases = cleanWorkAliases([...target.aliases, item.title, ...item.aliases], target.title).slice(0, aliasLimit);
  if (JSON.stringify(aliases) !== JSON.stringify(target.aliases)) patch.aliases = aliases;

  const msgIds = mergeIdLists(target.source_msg_ids, sourceMsgIds);
  if (msgIds.length !== target.source_msg_ids.length) patch.source_msg_ids = msgIds;

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * 把一批模型输出合并进片单，整批一个事务：任何一项写入失败都整体回滚。
 * 同一批里多项指向同一条目时按顺序应用（每项都读事务内的最新状态）。
 */
export function applyWorksUpdate(
  db: Database.Database,
  characterId: string,
  items: readonly WorksUpdateItem[],
  refMap: Readonly<Record<string, string>>,
  options: WorksUpdateApplyOptions,
): WorksUpdateApplyResult {
  return db.transaction((): WorksUpdateApplyResult => {
    const result: WorksUpdateApplyResult = { created: [], updated: [], skippedDismissed: 0, dropped: 0 };
    for (const raw of items) {
      const item = validateItem(raw);
      if (!item) {
        result.dropped += 1;
        continue;
      }

      const target = resolveTarget(db, characterId, item, refMap);
      if (target && target.dismissed_at !== null) {
        // 用户移除过的条目：不加回、不改动
        result.skippedDismissed += 1;
        structuredLog('info', 'memory.works_catalog.dismissed_skipped', {
          taskId: options.taskId,
          characterId,
          operation: 'works_catalog_update',
          status: 'skipped',
        });
        continue;
      }

      if (!target) {
        // 新增必须有状态
        if (!item.status) {
          result.dropped += 1;
          continue;
        }
        const created = createWork(db, {
          character_id: characterId,
          work_type: item.type,
          title: item.title,
          aliases: item.aliases,
          status: item.status,
          rating: item.rating,
          progress: item.progress,
          note: item.note,
          source_msg_ids: options.sourceMsgIds,
          first_seen_at: options.sourceTime || options.now,
        }, options.now);
        result.created.push(created.id);
        continue;
      }

      const patch = buildAutoPatch(target, item, options.sourceMsgIds);
      if (!patch) continue;
      updateWork(db, target.id, patch, options.now);
      if (!result.created.includes(target.id) && !result.updated.includes(target.id)) {
        result.updated.push(target.id);
      }
    }
    return result;
  })();
}

// ── 提示词 ──

function renderCurrentWorkLine(ref: string, entry: WorkEntry): string {
  return `${ref} ${JSON.stringify({
    type: entry.work_type,
    title: entry.title,
    aliases: entry.aliases,
    status: entry.status,
    rating: entry.rating,
    progress: entry.progress,
    note: entry.note,
  })}`;
}

/**
 * 组装提示词，同时给出 W 编号到条目 id 的映射（顺序与提示词里的编号严格一致）。
 * 已移除条目只列名称。占位符一次替换，对话里出现的花括号文本不会被二次展开。
 */
export function buildWorksCatalogUpdatePrompt(
  entries: readonly WorkEntry[],
  conversationText: string,
): { prompt: string; refMap: Record<string, string> } {
  const active = entries.filter(entry => entry.dismissed_at === null);
  const dismissed = entries.filter(entry => entry.dismissed_at !== null);
  const refMap: Record<string, string> = {};
  const currentLines = active.map((entry, index) => {
    const ref = `W${index + 1}`;
    refMap[ref] = entry.id;
    return renderCurrentWorkLine(ref, entry);
  });
  const values: Record<string, string> = {
    current_works: currentLines.length > 0 ? currentLines.join('\n') : '（空）',
    dismissed_works: dismissed.length > 0 ? dismissed.map(entry => `- 《${entry.title}》`).join('\n') : '（无）',
    conversation_text: conversationText,
  };
  const prompt = WORKS_CATALOG_UPDATE_PROMPT.replace(
    /\{(current_works|dismissed_works|conversation_text)\}/g,
    (_match, key: string) => values[key],
  );
  return { prompt, refMap };
}

// ── 调模型（照搬画像的后台配置解析）──

export interface WorksCatalogLlmRequest {
  db: Database.Database;
  characterId: string;
  prompt: string;
}

/** 返回模型的原始文本；测试可替换成假实现。 */
export type WorksCatalogLlmCall = (request: WorksCatalogLlmRequest) => Promise<string>;

const callWorksCatalogLlm: WorksCatalogLlmCall = async ({ db, characterId, prompt }) => {
  const loaded = loadSettings();
  const taskTarget = {
    character: loadCharacterTaskModels(db, characterId),
    kind: 'background' as const,
  };
  const bgConfig = resolveBackgroundConfig(loaded, taskTarget);
  const settings = mergeSettingsForBackgroundLlm(loaded, bgConfig, {
    json_mode: true,
    streaming: false,
    max_tokens: Math.max(loaded.max_tokens || 0, REASONING_SAFE_MAX_TOKENS),
  });
  if (!settings.api_base.trim() || !settings.model.trim()) {
    throw new Error('LLM provider is not configured for works catalog update');
  }
  const backgroundExtraBody = buildBackgroundChatExtraBody(settings.model, taskTarget);
  const messages = applyBackgroundSystemPrompt(
    [{ role: 'user', content: prompt }],
    resolveCharacterTaskSystemPrompt(taskTarget, settings.model),
  );
  return runWithBackgroundLlmDeadline(
    loaded.memory_background_timeout_ms,
    signal => chatCompletion(settings, messages, signal, backgroundExtraBody),
  );
};

// ── 队列 ──

interface WorksCatalogUpdateTaskRow {
  id: number;
  character_id: string;
  conversation_id: string | null;
  source_text: string;
  source_msg_ids: string;
  source_time: string | null;
  status: string;
  claim_token: string | null;
  lease_expires_at: string | null;
  retry_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorksCatalogUpdateInput {
  sourceText: string;
  sourceMsgIds: readonly string[];
  sourceTime: string | null;
  conversationId: string | null;
}

function isConversationMemoryIgnored(db: Database.Database, conversationId: string): boolean {
  const row = db.prepare('SELECT ignore_memory FROM conversations WHERE id = ?').get(conversationId) as
    | { ignore_memory: number | null }
    | undefined;
  return Boolean(row?.ignore_memory);
}

/**
 * 入队一次片单更新。返回任务 id；对话设为「不提取记忆」或对话文本为空时不入队，返回 null。
 * 聊天自动触发本就不会为 ignore_memory 对话提取，但手动提取接口不检查该开关，所以这里再拦一次。
 */
export function enqueueWorksCatalogUpdate(
  characterId: string,
  input: WorksCatalogUpdateInput,
  db: Database.Database = getDb(),
): number | null {
  if (!input.sourceText.trim()) return null;
  if (input.conversationId && isConversationMemoryIgnored(db, input.conversationId)) return null;
  const enqueued = worksTaskQueue.enqueue(db, {
    columns: {
      character_id: characterId,
      conversation_id: input.conversationId,
      source_text: input.sourceText,
      source_msg_ids: JSON.stringify(mergeIdLists(input.sourceMsgIds)),
      source_time: input.sourceTime,
      retry_count: 0,
    },
  });
  if (enqueued.id == null) {
    throw new Error(`failed to enqueue works catalog update for character ${characterId}`);
  }
  return enqueued.id;
}

function parseIdList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 一个任务最多尝试几次（含第一次）。失败后放回 pending，退避一段时间后按 id 顺序重新认领，
 * 后面的任务等它成功或用完次数再处理，保证「后一轮对话覆盖前一轮」的顺序不被打乱。
 */
export const WORKS_UPDATE_MAX_ATTEMPTS = 3;

/**
 * 第 n 次失败（n 从 0 计，即失败前的 retry_count）后等多久再重试。
 * 立刻重试会让一次短暂断线或 429 在几毫秒内把次数用光。
 */
export const WORKS_UPDATE_RETRY_DELAYS_MS: readonly number[] = [5000, 30000];

let retryDelaysMs: readonly number[] = WORKS_UPDATE_RETRY_DELAYS_MS;

/** 仅测试用：替换退避时间；传 null 恢复默认。 */
export function __setWorksCatalogRetryDelaysForTests(delays: readonly number[] | null): void {
  retryDelaysMs = delays ?? WORKS_UPDATE_RETRY_DELAYS_MS;
}

function retryDelayFor(retryCount: number): number {
  if (retryDelaysMs.length === 0) return 0;
  return Math.max(0, retryDelaysMs[Math.min(retryCount, retryDelaysMs.length - 1)]);
}

export interface ProcessWorksCatalogUpdateResult {
  processed: number;
  skipped: number;
  /** 用完尝试次数、进入 failed 终态的任务数 */
  failed: number;
  /** 本轮失败但放回 pending 等待重试的任务数 */
  retried: number;
  /** 放回 pending 的任务应在多久后再认领（毫秒）；没有重试时为 0。由后台排空负责等待。 */
  retryDelayMs: number;
  claimed: number;
  remaining: number;
}

export async function processWorksCatalogUpdateTasks(options: {
  db?: Database.Database;
  limit?: number;
  leaseSeconds?: number;
  callLlm?: WorksCatalogLlmCall;
} = {}): Promise<ProcessWorksCatalogUpdateResult> {
  const db = options.db || getDb();
  const limit = Math.max(1, Math.floor(options.limit ?? 10));
  const leaseSeconds = Math.max(1, Math.floor(options.leaseSeconds ?? 300));
  const callLlm = options.callLlm || callWorksCatalogLlm;
  const tasks = worksTaskQueue.claim<WorksCatalogUpdateTaskRow>(db, { limit, leaseSeconds });

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let retried = 0;
  let retryDelayMs = 0;

  // 按 id 顺序逐个处理：后一轮对话的说法要覆盖前一轮
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    try {
      const sourceText = task.source_text.trim();
      if (!sourceText) {
        worksTaskQueue.complete(db, task, { errorMessage: 'empty source text skipped' });
        skipped += 1;
        continue;
      }

      const { prompt, refMap } = buildWorksCatalogUpdatePrompt(
        listWorks(db, task.character_id, { includeDismissed: true }),
        sourceText,
      );
      const response = await callLlm({ db, characterId: task.character_id, prompt });
      // 解析失败直接抛：任务进入失败，片单不动
      const items = parseWorksUpdateResponse(response);

      const applied = db.transaction(() => {
        // 租约过期被别的处理者回收时不写入
        if (!worksTaskQueue.confirmClaim(db, task)) return null;
        const result = applyWorksUpdate(db, task.character_id, items, refMap, {
          sourceMsgIds: parseIdList(task.source_msg_ids),
          sourceTime: task.source_time,
          now: new Date().toISOString(),
          taskId: task.id,
        });
        const changed = result.created.length + result.updated.length > 0;
        worksTaskQueue.complete(db, task, changed ? {} : { errorMessage: 'no works catalog changes' });
        return result;
      })();

      if (applied && applied.created.length + applied.updated.length > 0) {
        processed += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logFields = {
        taskId: task.id,
        characterId: task.character_id,
        conversationId: task.conversation_id ?? undefined,
        operation: 'works_catalog_update',
        attempt: task.retry_count + 1,
      };
      if (task.retry_count + 1 < WORKS_UPDATE_MAX_ATTEMPTS) {
        // 还有次数：放回 pending，本批后面已认领的任务一并放回，退避后下一轮按 id 顺序先重试它
        retried += 1;
        retryDelayMs = retryDelayFor(task.retry_count);
        structuredLog('warn', 'memory.works_catalog.update_retrying', { ...logFields, status: 'retrying' }, error);
        worksTaskQueue.requeue(db, task, { errorMessage: message, incrementRetry: true });
        for (const rest of tasks.slice(index + 1)) worksTaskQueue.requeue(db, rest);
        break;
      }
      failed += 1;
      structuredLog('error', 'memory.works_catalog.update_failed', { ...logFields, status: 'failed' }, error);
      worksTaskQueue.fail(db, task, message);
    }
  }

  const remaining = worksTaskQueue.countClaimable(db);
  return { processed, skipped, failed, retried, retryDelayMs, claimed: tasks.length, remaining };
}

// ── 后台驱动（简单 drain 闸门由 DbTaskQueue 提供）──
// 片单更新是较慢的后台 LLM 调用，必须异步排空、不阻塞调用方（提取队列 / 启动流程）。
const worksDrainGate = worksTaskQueue.createDrainGate(
  async () => {
    // 每轮只认领一个：模型调用较慢，一次认领多个会让排在后面的任务租约先过期
    const result = await processWorksCatalogUpdateTasks({ limit: 1 });
    // 有任务放回重试时先退避再进入下一轮。排空是唯一的消费者且总认领 id 最小的任务，
    // 等待期间该任务保持 pending、不占租约，后面的任务继续排在它之后。
    // 定时器 unref：进程退出时不为一次退避续命，pending 任务在下次启动时由恢复流程重新唤醒。
    if (result.retryDelayMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, result.retryDelayMs).unref());
    }
    return { claimed: result.claimed };
  },
  {
    maxRounds: 1000,
    onError: (err) => {
      structuredLog('error', 'memory.works_catalog.queue_failed', {
        operation: 'drain',
        status: 'failed',
      }, err);
    },
  },
);

/** 触发片单更新队列：异步循环排空，不阻塞调用方；已在处理时直接返回。 */
export function triggerWorksCatalogQueue(): void {
  worksDrainGate.trigger();
}

/** 服务启动时调用：仅回收租约已过期或缺失的 processing 任务，不抢另一实例 in-flight 任务。 */
export function recoverStaleWorksCatalogTasks(db: Database.Database = getDb()): void {
  worksTaskQueue.recoverStale(db);
}
