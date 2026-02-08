import { apiFetch } from './client';

export interface ColonySummary {
  roomName: string;
  rcl: number;
  rclProgress: number;
  rclProgressTotal: number;
  energy: number;
  energyCapacity?: number;
  creepCount: number;
  creepsByRole: Record<string, number>;
  threats: {
    hostile: boolean;
    hostileCount?: number;
  };
  constructionSites: number;
  remoteRooms: string[];
  spawning?: {
    name: string;
    role: string;
  } | null;
}

export interface ColoniesResponse {
  global: unknown;
  colonies: ColonySummary[];
  colonyCount: number;
  gameTick: number;
}

export function fetchColonies() {
  return apiFetch<ColoniesResponse>('/colonies');
}

export function fetchColony(room: string) {
  return apiFetch<unknown>(`/colonies/${room}`);
}

export function fetchColonyCreeps(room: string) {
  return apiFetch<unknown>(`/colonies/${room}/creeps`);
}

export function fetchColonyEconomy(room: string) {
  return apiFetch<unknown>(`/colonies/${room}/economy`);
}

export function fetchColonyRemotes(room: string) {
  return apiFetch<unknown>(`/colonies/${room}/remotes`);
}
