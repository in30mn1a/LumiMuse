import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { agentSessionCreateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { readJsonObject } from '@/lib/request-json';
import { createAgentSession, listAgentSessions } from '@/lib/agent/store';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function pageParam(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const limit = pageParam(params.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const offset = pageParam(params.get('offset'), 0, Number.MAX_SAFE_INTEGER);
  return NextResponse.json(listAgentSessions(getDb(), limit, offset));
}

export async function POST(request: NextRequest) {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const parsed = agentSessionCreateSchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const session = createAgentSession(getDb(), parsed.data, new Date().toISOString());
  return NextResponse.json(session, { status: 201 });
}
