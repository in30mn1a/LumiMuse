import { safeFetch } from '@/lib/ssrf-guard';

export interface RerankerAdapterConfig {
  api_base?: string;
  api_key?: string;
  model?: string;
  timeout_ms?: number;
}

export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

function normalizeRerankEndpoint(apiBase: string): string {
  const trimmed = apiBase.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/rerank')) return trimmed;
  return `${trimmed}/rerank`;
}

function parseScore(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseRerankerResponse(data: unknown, documents: RerankDocument[]): RerankResult[] {
  const record = data as Record<string, unknown>;

  if (Array.isArray(record.scores)) {
    return record.scores
      .map((score, index) => ({ id: documents[index]?.id, score: parseScore(score) }))
      .filter((item): item is RerankResult => !!item.id && item.score !== null);
  }

  const rawResults = Array.isArray(record.results)
    ? record.results
    : Array.isArray(record.data)
      ? record.data
      : [];

  const results: RerankResult[] = [];
  for (const item of rawResults) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const index = Number(row.index ?? row.document_index);
    const id = typeof row.id === 'string' ? row.id : documents[index]?.id;
    const score = parseScore(row.relevance_score ?? row.score);
    if (id && score !== null) {
      results.push({ id, score });
    }
  }

  return results;
}

export async function rerankDocuments(
  query: string,
  documents: RerankDocument[],
  config: RerankerAdapterConfig,
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];

  const apiBase = config.api_base?.trim();
  const model = config.model?.trim();
  if (!apiBase) throw new Error('reranker api_base is required');
  if (!model) throw new Error('reranker model is required');

  const controller = new AbortController();
  const timeoutMs = Math.max(1, config.timeout_ms || 2000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.api_key) headers.Authorization = `Bearer ${config.api_key}`;

    const response = await safeFetch(normalizeRerankEndpoint(apiBase), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        query,
        documents: documents.map(doc => doc.text),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`reranker API error ${response.status}: ${errorText.slice(0, 200)}`);
    }

    return parseRerankerResponse(await response.json(), documents);
  } finally {
    clearTimeout(timer);
  }
}
