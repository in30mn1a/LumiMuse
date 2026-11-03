import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getMemorySystemStatus } from '@/lib/memory-status';
import { loadSettings, resolveAgentConfig } from '@/lib/settings';

const RECENT_ERROR_WINDOW_HOURS = 24;

/** Agent 页面顶部的状态条。只读数据库，不调用模型，上游故障时也能显示。 */
export async function GET() {
  const db = getDb();
  const status = getMemorySystemStatus(db);
  const since = new Date(Date.now() - RECENT_ERROR_WINDOW_HOURS * 3600_000).toISOString();
  const recentErrors = (db.prepare("SELECT COUNT(*) AS count FROM app_events WHERE level = 'error' AND ts >= ?").get(since) as
    { count: number }).count;
  const config = resolveAgentConfig(loadSettings());
  const provider = config.provider_id
    ? db.prepare('SELECT name FROM api_providers WHERE id = ?').get(config.provider_id) as { name: string } | undefined
    : undefined;

  return NextResponse.json({
    failed_tasks: {
      extraction: status.queues.extraction.failed,
      profile: status.queues.profile.failed,
      embedding: status.queues.embedding.failed,
    },
    repairable_candidates: status.candidates.repairable,
    recent_errors: recentErrors,
    recent_error_window_hours: RECENT_ERROR_WINDOW_HOURS,
    agent: {
      configured: Boolean(config.api_base && config.model),
      provider_name: provider?.name ?? null,
      model: config.model,
    },
  });
}
