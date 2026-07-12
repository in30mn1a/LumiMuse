export class HttpResponseError<T = unknown> extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data: T | null,
  ) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

async function readJson(response: Response): Promise<{ data: unknown; isJson: boolean }> {
  const text = await response.text();
  if (!text.trim()) return { data: null, isJson: false };

  try {
    return { data: JSON.parse(text), isJson: true };
  } catch {
    return { data: null, isJson: false };
  }
}

function getResponseErrorMessage(data: unknown, status: number): string {
  const message = data && typeof data === 'object'
    ? ((data as { error?: unknown; message?: unknown }).error || (data as { error?: unknown; message?: unknown }).message)
    : null;
  return typeof message === 'string' && message ? message : `HTTP ${status}`;
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const { data, isJson } = await readJson(response);
  if (!response.ok) {
    throw new HttpResponseError(getResponseErrorMessage(data, response.status), response.status, data);
  }
  if (!isJson) {
    throw new HttpResponseError(`Invalid JSON response (HTTP ${response.status})`, response.status, null);
  }
  return data as T;
}

export async function parseJsonArrayResponse<T>(response: Response): Promise<T[]> {
  const data = await parseJsonResponse<unknown>(response);
  if (!Array.isArray(data)) {
    throw new HttpResponseError(`Expected JSON array (HTTP ${response.status})`, response.status, data);
  }
  return data as T[];
}

export async function expectOkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await parseJsonResponse<unknown>(response);
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
