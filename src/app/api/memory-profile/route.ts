import { NextRequest, NextResponse } from 'next/server';
import {
  deleteMemoryProfileVersion,
  enqueueMemoryProfileUpdate,
  enqueueMemoryProfilePatchExtraction,
  getMemoryProfileTaskSummaries,
  getMemoryProfileUpdateTasks,
  getMemoryProfileVersions,
  getOrCreateMemoryProfile,
  processMemoryProfileUpdateTasks,
  readMemoryProfile,
  rollbackMemoryProfile,
  triggerMemoryProfileQueue,
  type MemoryProfilePatch,
} from '@/lib/memory-profile';
import { getDb } from '@/lib/db';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCharacterId(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function isPatch(value: unknown): value is MemoryProfilePatch {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseBoundedInteger(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function parseOffset(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function getTaskById(characterId: string, taskId: number) {
  return getMemoryProfileUpdateTasks(characterId).find(task => task.id === taskId);
}

function failedTaskResponse(
  task: ReturnType<typeof getTaskById>,
  processResult: Awaited<ReturnType<typeof processMemoryProfileUpdateTasks>>,
  profile: ReturnType<typeof readMemoryProfile>,
) {
  return NextResponse.json({
    ok: false,
    error: 'profile_update_failed',
    detail: task?.error_message || 'memory profile update task did not complete',
    task,
    task_result: processResult,
    profile,
  }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const characterId = parseCharacterId(request.nextUrl.searchParams.get('character_id'));
  if (!characterId) {
    return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
  }
  const versionsLimit = parseBoundedInteger(request.nextUrl.searchParams.get('versions_limit'), 50, 100);
  const versionsOffset = parseOffset(request.nextUrl.searchParams.get('versions_offset'));

  try {
    const profile = readMemoryProfile(characterId);
    return NextResponse.json({
      profile,
      versions: getMemoryProfileVersions(characterId, undefined, {
        limit: versionsLimit,
        offset: versionsOffset,
      }),
      tasks: getMemoryProfileTaskSummaries(characterId),
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read memory profile', detail: getErrorMessage(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }

  const body = rawBody as {
    action?: unknown;
    character_id?: unknown;
    patch?: unknown;
    reason?: unknown;
    version_id?: unknown;
    limit?: unknown;
  };
  const action = typeof body.action === 'string' ? body.action : '';
  const characterId = typeof body.character_id === 'string' ? body.character_id.trim() : '';

  try {
    if (action === 'enqueue') {
      if (!characterId) return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
      if (!isPatch(body.patch)) return NextResponse.json({ error: 'patch must be an object' }, { status: 400 });
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'api';
      const task = enqueueMemoryProfileUpdate(characterId, body.patch, reason);
      const processResult = await processMemoryProfileUpdateTasks({ taskId: task.id, characterId });
      const profile = readMemoryProfile(characterId);
      const currentTask = getTaskById(characterId, task.id);
      if (currentTask?.status !== 'done') {
        if (processResult.remaining > 0) {
          triggerMemoryProfileQueue();
        }
        return failedTaskResponse(currentTask, processResult, profile);
      }
      if (processResult.remaining > 0) {
        triggerMemoryProfileQueue();
      }
      return NextResponse.json({
        ok: true,
        task: currentTask,
        task_result: processResult,
        profile,
      }, { status: 201 });
    }

    if (action === 'process') {
      const limit = parseBoundedInteger(
        typeof body.limit === 'string' || typeof body.limit === 'number' ? String(body.limit) : null,
        10,
        50,
      );
      return NextResponse.json({ ok: true, ...await processMemoryProfileUpdateTasks({ limit }) });
    }

    if (action === 'rollback') {
      if (!characterId) return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
      const versionId = Number(body.version_id);
      if (!Number.isInteger(versionId) || versionId <= 0) {
        return NextResponse.json({ error: 'version_id must be a positive integer' }, { status: 400 });
      }
      return NextResponse.json({ ok: true, profile: rollbackMemoryProfile(characterId, versionId) });
    }

    if (action === 'delete_version') {
      if (!characterId) return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
      const versionId = Number(body.version_id);
      if (!Number.isInteger(versionId) || versionId <= 0) {
        return NextResponse.json({ error: 'version_id must be a positive integer' }, { status: 400 });
      }
      return NextResponse.json({
        ok: true,
        deleted: deleteMemoryProfileVersion(characterId, versionId),
      });
    }

    if (action === 'init') {
      if (!characterId) return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
      const existingProfile = readMemoryProfile(characterId);
      const profile = existingProfile ?? getOrCreateMemoryProfile(characterId);
      const created = !existingProfile;
      return NextResponse.json({
        ok: true,
        status: created ? 'created' : 'already_exists',
        created,
        already_exists: !created,
        profile,
      });
    }

    if (action === 'init_from_memories') {
      if (!characterId) return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
      const db = getDb();

      // 读取角色信息
      const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) as
        | { name: string; basic_info: string; personality: string; scenario: string; other_info: string; system_prompt: string }
        | undefined;
      if (!character) {
        return NextResponse.json({ ok: false, error: 'character_not_found' }, { status: 400 });
      }

      // 读取角色所有 active 记忆
      const memories = db.prepare(
        "SELECT content, category, importance FROM memories WHERE character_id = ? AND status = 'active' ORDER BY importance DESC, updated_at DESC"
      ).all(characterId) as Array<{ content: string; category: string; importance: number }>;

      if (memories.length === 0) {
        return NextResponse.json({ ok: false, error: 'no_active_memories' }, { status: 400 });
      }

      const parts: string[] = [];
      const charName = character.name || '角色';

      // ── 角色信息 ──
      const charInfoParts: string[] = [];
      if (character.name) charInfoParts.push(`角色名称：${character.name}`);
      if (character.system_prompt) charInfoParts.push(`系统提示：${character.system_prompt}`);
      if (character.basic_info) charInfoParts.push(`基本信息：${character.basic_info}`);
      if (character.personality) charInfoParts.push(`性格：${character.personality}`);
      if (character.scenario) charInfoParts.push(`场景设定：${character.scenario}`);
      if (character.other_info) charInfoParts.push(`其他补充：${character.other_info}`);
      if (charInfoParts.length > 0) {
        parts.push('【角色信息】', ...charInfoParts);
      }

      // ── 每个对话随机采样 10 条用户消息 + 对应角色回复 ──
      const conversations = db.prepare(
        'SELECT id FROM conversations WHERE character_id = ? ORDER BY updated_at DESC'
      ).all(characterId) as Array<{ id: string }>;

      if (conversations.length > 0) {
        parts.push('【对话历史采样】');
        for (const conv of conversations) {
          // 随机取 10 条用户消息
          const userMsgs = db.prepare(
            `SELECT id, content, created_at FROM messages
             WHERE conversation_id = ? AND role = 'user'
             ORDER BY RANDOM() LIMIT 10`
          ).all(conv.id) as Array<{ id: string; content: string; created_at: string }>;

          if (userMsgs.length === 0) continue;

          // 按时间排序保持对话流
          userMsgs.sort((a, b) => a.created_at.localeCompare(b.created_at));

          const lines: string[] = [];
          for (const um of userMsgs) {
            const d = new Date(um.created_at);
            const ts = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            lines.push(`用户 (${ts}): ${um.content}`);

            // 取下一条 assistant 回复
            const nextAssistant = db.prepare(
              `SELECT content, created_at FROM messages
               WHERE conversation_id = ? AND role = 'assistant' AND created_at > ?
               ORDER BY created_at ASC, seq ASC LIMIT 1`
            ).get(conv.id, um.created_at) as { content: string; created_at: string } | undefined;

            if (nextAssistant) {
              const ad = new Date(nextAssistant.created_at);
              const ats = `${ad.getFullYear()}/${ad.getMonth() + 1}/${ad.getDate()} ${String(ad.getHours()).padStart(2, '0')}:${String(ad.getMinutes()).padStart(2, '0')}`;
              lines.push(`${charName} (${ats}): ${nextAssistant.content}`);
            }
          }

          if (lines.length > 0) {
            parts.push('');
            parts.push(`-- 对话 ${conv.id.slice(0, 8)}（采样 ${userMsgs.length} 条）--`);
            parts.push(...lines);
          }
        }
      }

      // ── 全量活跃记忆 ──
      parts.push('');
      parts.push(`【活跃记忆（共 ${memories.length} 条）】`);
      parts.push(...memories.map(m => `[${m.category}] ${m.content}`));

      const sourceText = parts.join('\n');

      getOrCreateMemoryProfile(characterId);
      const task = enqueueMemoryProfilePatchExtraction(characterId, sourceText, 'init_from_memories');
      const processResult = await processMemoryProfileUpdateTasks({ taskId: task.id, characterId });
      const profile = readMemoryProfile(characterId);
      const currentTask = getTaskById(characterId, task.id);
      if (currentTask?.status !== 'done') {
        if (processResult.remaining > 0) {
          triggerMemoryProfileQueue();
        }
        return failedTaskResponse(currentTask, processResult, profile);
      }
      if (processResult.remaining > 0) {
        triggerMemoryProfileQueue();
      }
      const noProfileChanges = processResult.processed === 0
        && processResult.skipped > 0
        && processResult.failed === 0;

      return NextResponse.json({
        ok: true,
        status: noProfileChanges ? 'no_changes' : 'processed',
        memory_count: memories.length,
        conversation_count: conversations.length,
        task_id: task.id,
        task: currentTask,
        task_result: processResult,
        profile,
      });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update memory profile', detail: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
