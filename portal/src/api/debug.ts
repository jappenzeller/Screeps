import { apiFetch } from './client';
import type { CommandQueueResponse, CommandResult, PositionData } from '../types/debug';

// Queue a command via POST (preferred — no URL length limits)
export function postCommand(command: string, shard: string = 'shard0') {
  return apiFetch<CommandQueueResponse>('/debug/command', {
    method: 'POST',
    body: JSON.stringify({ command, shard }),
  });
}

// Queue a command via GET (alternative, base64 encoded)
export function getCommand(command: string) {
  const encoded = btoa(command);
  return apiFetch<CommandQueueResponse>(`/debug/command?cmd=${encoded}`);
}

// Fetch result of a previously queued command
export function fetchCommandResult(requestId?: string) {
  const qs = requestId ? `?requestId=${requestId}` : '';
  return apiFetch<CommandResult>(`/debug/command/result${qs}`);
}

// Fetch creep position data from segment 92
export function fetchPositions() {
  return apiFetch<PositionData>('/debug/positions');
}
