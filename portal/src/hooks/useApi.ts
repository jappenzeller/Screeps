import { useState, useEffect, useRef, useCallback } from 'react';
import type { ApiMeta } from '../api/client';

interface UseApiOptions {
  pollInterval?: number; // ms, 0 to disable
  enabled?: boolean;
}

interface UseApiResult<T> {
  data: T | null;
  meta: ApiMeta | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useApi<T>(
  fetcher: () => Promise<{ data: T; meta: ApiMeta }>,
  deps: unknown[] = [],
  options: UseApiOptions = {}
): UseApiResult<T> {
  const { pollInterval = 0, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const doFetch = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (mountedRef.current) {
        setData(result.data);
        setMeta(result.meta);
        setError(null);
        setLoading(false);
      }
    } catch (e) {
      if (mountedRef.current) {
        setError(e as Error);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      setLoading(false);
      return;
    }

    setLoading(true);
    doFetch();

    let interval: ReturnType<typeof setInterval> | null = null;
    if (pollInterval > 0) {
      interval = setInterval(() => {
        if (!document.hidden) {
          doFetch();
        }
      }, pollInterval);
    }

    return () => {
      mountedRef.current = false;
      if (interval) {
        clearInterval(interval);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, pollInterval, doFetch]);

  return { data, meta, loading, error, refetch: doFetch };
}
