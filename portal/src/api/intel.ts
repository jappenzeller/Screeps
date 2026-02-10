import { apiFetch } from './client';
import type { IntelResponse, RoomIntel, EnemyResponse, CandidateResponse } from '../types/intel';
import type { ApiMeta } from './client';

// Raw shape after apiFetch strips meta fields
// (source, freshness, fetchedAt, gameTick already removed)
interface RawIntelData {
  homeRoom: string;
  range: string;
  rooms: RoomIntel[];  // Array from API
}

export async function fetchAllIntel(): Promise<{ data: IntelResponse; meta: ApiMeta }> {
  const raw = await apiFetch<RawIntelData>('/intel');

  // Transform rooms array → Record<string, RoomIntel>
  const roomMap: Record<string, RoomIntel> = {};
  if (Array.isArray(raw.data.rooms)) {
    for (const room of raw.data.rooms) {
      roomMap[room.roomName] = room;
    }
  }

  return {
    data: {
      rooms: roomMap,
      scannedCount: Object.keys(roomMap).length,
    },
    meta: raw.meta,
  };
}

export function fetchIntelRoom(roomName: string) {
  return apiFetch<RoomIntel>(`/intel/${roomName}`);
}

export function fetchEnemies() {
  return apiFetch<EnemyResponse>('/intel/enemies');
}

export function fetchCandidates() {
  return apiFetch<CandidateResponse>('/intel/candidates');
}
