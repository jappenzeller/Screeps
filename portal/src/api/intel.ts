import { apiFetch } from './client';
import type { IntelResponse, RoomIntel, EnemyResponse, CandidateResponse } from '../types/intel';

export function fetchAllIntel() {
  return apiFetch<IntelResponse>('/intel');
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
