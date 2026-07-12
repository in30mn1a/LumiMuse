import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeMemoryCategory, inferMemoryDefaults } from '@/lib/memory-category';
import { normalizeMemoryRow } from '@/lib/memory-normalization';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';
import { Memory } from '@/types';
import { formatZodFieldErrors, memoryCreateSchema } from '@/lib/schemas';

type CandidateRow = {
  id: number;
  character_id: string;
  raw_candidate_json: string | null;
  status: string;
};

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function readJsonBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const raw = await request.json();
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const body = await readJsonBody(request);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const action = body.action;
  if (action !== 'accept' && action !== 'discard' && action !== 'ignore') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }

  const { id } = await params;
  const db = getDb();
  const candidate = db.prepare('SELECT id, character_id, raw_candidate_json, status FROM memory_extraction_candidates WHERE id = ?')
    .get(id) as CandidateRow | undefined;
  if (!candidate) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (candidate.status !== 'repairable') {
    return NextResponse.json({ error: 'Candidate is not repairable' }, { status: 409 });
  }

  const now = new Date().toISOString();
  if (action === 'discard' || action === 'ignore') {
    const status = action === 'discard' ? 'discarded' : 'ignored';
    const statusUpdate = db.prepare(`
      UPDATE memory_extraction_candidates
      SET status = ?, updated_at = ?
      WHERE id = ? AND status = 'repairable'
    `)
      .run(status, now, id);
    if (statusUpdate.changes === 0) {
      return NextResponse.json({ error: 'Candidate is not repairable' }, { status: 409 });
    }
    return NextResponse.json({ ok: true, status });
  }

  const rawCandidate = parseJsonObject(candidate.raw_candidate_json);
  const override = parseJsonObject(body.memory);
  const parsed = memoryCreateSchema.safeParse({
    ...rawCandidate,
    ...override,
    character_id: candidate.character_id,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }

  const memory = parsed.data;
  const memoryId = crypto.randomUUID().slice(0, 12);
  const category = normalizeMemoryCategory(memory.category);
  const defaults = inferMemoryDefaults(category);
  const sourceMsgIds = parseJsonArray(rawCandidate.source_msg_ids);

  const accepted = db.transaction(() => {
    const statusUpdate = db.prepare(`
      UPDATE memory_extraction_candidates
      SET status = ?, updated_at = ?
      WHERE id = ? AND status = 'repairable'
    `).run('repaired', now, id);
    if (statusUpdate.changes === 0) return false;

    db.prepare(`
      INSERT INTO memories (
        id, character_id, category, content, confidence, tags, source_msg_ids,
        memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memoryId,
      candidate.character_id,
      category,
      memory.content,
      memory.confidence ?? 0.9,
      JSON.stringify(memory.tags || []),
      JSON.stringify(sourceMsgIds),
      memory.memory_kind ?? defaults.memory_kind,
      memory.importance ?? defaults.importance,
      memory.emotional_weight ?? defaults.emotional_weight,
      memory.status ?? 'active',
      memory.pinned ? 1 : 0,
      memory.last_used_at ?? null,
      memory.usage_count ?? 0,
      JSON.stringify(memory.metadata ?? {}),
      now,
      now,
    );
    return true;
  })();

  if (!accepted) {
    return NextResponse.json({ error: 'Candidate is not repairable' }, { status: 409 });
  }

  try {
    if (enqueueMemoryEmbeddingTask(memoryId, candidate.character_id, 'created', db)) {
      triggerMemoryIndexProcessing();
    }
  } catch (error) {
    console.error('Failed to enqueue memory embedding task after candidate accept', {
      memoryId,
      candidateId: candidate.id,
      characterId: candidate.character_id,
      error,
    });
  }

  const created = db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as Memory;
  return NextResponse.json({ ok: true, memory: normalizeMemoryRow(created) }, { status: 201 });
}
