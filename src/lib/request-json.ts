import { NextRequest, NextResponse } from 'next/server';

type JsonObject = Record<string, unknown>;

type ReadJsonObjectResult =
  | { ok: true; data: JsonObject }
  | { ok: false; response: NextResponse };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readJsonObject(request: NextRequest): Promise<ReadJsonObjectResult> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
    };
  }

  if (!isJsonObject(body)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid request body' }, { status: 400 }),
    };
  }

  return { ok: true, data: body };
}
