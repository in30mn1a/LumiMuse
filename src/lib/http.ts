export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object'
      ? ((data as { error?: unknown; message?: unknown }).error || (data as { error?: unknown; message?: unknown }).message)
      : null;
    throw new Error(typeof message === 'string' && message ? message : `HTTP ${response.status}`);
  }
  return data as T;
}

export async function expectOkResponse(response: Response): Promise<void> {
  await parseJsonResponse<unknown>(response);
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
