import { useRef, useCallback } from 'react';
import { fetchSnapshot } from '../../api/recordings';
import type { Snapshot } from '../../types/recordings';

const BUFFER_SIZE = 40;
const BATCH_SIZE = 20;
const MAX_CACHE = 80;

export function useSnapshotCache(recordingId: string | null) {
  const cache = useRef<Map<number, Snapshot>>(new Map());
  const loading = useRef<Set<number>>(new Set());

  const get = useCallback((tick: number): Snapshot | null => {
    return cache.current.get(tick) ?? null;
  }, []);

  const prefetch = useCallback(async (startIndex: number, tickList: number[]) => {
    if (!recordingId || tickList.length === 0) return;

    const toLoad: number[] = [];
    for (let i = startIndex; i < Math.min(startIndex + BUFFER_SIZE, tickList.length); i++) {
      const tick = tickList[i];
      if (!cache.current.has(tick) && !loading.current.has(tick)) {
        toLoad.push(tick);
      }
    }

    if (toLoad.length === 0) return;

    // Batch fetch
    for (let i = 0; i < toLoad.length; i += BATCH_SIZE) {
      const batch = toLoad.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (tick) => {
          loading.current.add(tick);
          try {
            const response = await fetchSnapshot(recordingId, tick);
            cache.current.set(tick, response.data);
          } catch (e) {
            console.warn('Failed to load snapshot', tick, e);
          } finally {
            loading.current.delete(tick);
          }
        })
      );
    }

    // Evict old entries
    if (cache.current.size > MAX_CACHE) {
      const threshold = tickList[Math.max(0, startIndex - 10)];
      for (const [tick] of cache.current) {
        if (tick < threshold && cache.current.size > MAX_CACHE / 2) {
          cache.current.delete(tick);
        }
      }
    }
  }, [recordingId]);

  const clear = useCallback(() => {
    cache.current.clear();
    loading.current.clear();
  }, []);

  const has = useCallback((tick: number): boolean => {
    return cache.current.has(tick);
  }, []);

  return { get, prefetch, clear, has };
}
