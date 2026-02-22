const API_BASE = 'https://g9gplzbul4.execute-api.us-east-1.amazonaws.com';

export interface ApiMeta {
  source: 'segment90' | 'dynamodb' | 'screeps-api' | 'unknown';
  freshness: number;
  fetchedAt: number;
  gameTick?: number;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<{ data: T; meta: ApiMeta }> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text);
  }

  const raw = await res.json();

  // Handle array responses — no meta fields to strip
  if (Array.isArray(raw)) {
    return {
      data: raw as T,
      meta: {
        source: 'unknown',
        freshness: 0,
        fetchedAt: Date.now(),
      },
    };
  }

  // Handle null/primitive responses
  if (!raw || typeof raw !== 'object') {
    return {
      data: raw as T,
      meta: {
        source: 'unknown',
        freshness: 0,
        fetchedAt: Date.now(),
      },
    };
  }

  const { source, freshness, fetchedAt, gameTick, ...data } = raw;

  return {
    data: data as T,
    meta: {
      source: source || 'unknown',
      freshness: freshness || 0,
      fetchedAt: fetchedAt || Date.now(),
      gameTick,
    },
  };
}
