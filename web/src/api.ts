export type Selection = { sourceIds: string[]; libraryIds: string[]; version: string };
export type Citation = { id: string; name: string; format: string; number: number; library?: string };

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message ?? body.message ?? '请求失败，请重试。');
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export function post<T>(path: string, body: unknown, signal?: AbortSignal) {
  return api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请重试。';
}
