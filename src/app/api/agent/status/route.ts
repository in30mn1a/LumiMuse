import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { loadSettings, resolveAgentConfig } from '@/lib/settings';
import { readJsonObject } from '@/lib/request-json';
import { AGENT_ISSUE_KINDS, dismissAgentIssueSnapshot, readActiveAgentIssueSnapshot } from '@/lib/agent/status-dismissals';

const RECENT_ERROR_WINDOW_HOURS = 24;

function readStatus() {
  const db = getDb();
  const since = new Date(Date.now() - RECENT_ERROR_WINDOW_HOURS * 3600_000).toISOString();
  const snapshot = readActiveAgentIssueSnapshot(db, since);
  const counts = { extraction: 0, profile: 0, embedding: 0, repairable: 0, errors: 0 };
  for (const item of snapshot) counts[item.kind] += 1;
  const config = resolveAgentConfig(loadSettings());
  const provider = config.provider_id
    ? db.prepare('SELECT name FROM api_providers WHERE id = ?').get(config.provider_id) as { name: string } | undefined
    : undefined;

  return NextResponse.json({
    failed_tasks: {
      extraction: counts.extraction,
      profile: counts.profile,
      embedding: counts.embedding,
    },
    repairable_candidates: counts.repairable,
    recent_errors: counts.errors,
    recent_error_window_hours: RECENT_ERROR_WINDOW_HOURS,
    dismissal_snapshot: snapshot,
    agent: {
      configured: Boolean(config.api_base && config.model),
      provider_name: provider?.name ?? null,
      model: config.model,
    },
  });
}

/** Agent 页面顶部的活跃问题。不调用模型，上游故障时也能显示。 */
export async function GET() {
  return readStatus();
}

const dismissSchema = z.object({
  dismissal_snapshot: z.array(z.object({
    kind: z.enum(AGENT_ISSUE_KINDS), id: z.number().int().positive(), version: z.string(),
  })),
});

/** 主人明确忽略已展示的问题；源记录保留，Agent 默认不再关注。 */
export async function POST(request: NextRequest) {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const parsed = dismissSchema.safeParse(body.data);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  dismissAgentIssueSnapshot(getDb(), parsed.data.dismissal_snapshot, new Date().toISOString());
  return readStatus();
}
