// Response from POST /debug/command
export interface CommandQueueResponse {
  success: boolean;
  requestId: string;
  command: string;
  shard: string;
  message: string;
  error?: string;
}

// Response from GET /debug/command/result
// This reads segment 91 which contains the executed command result
export interface CommandResult {
  status: 'pending' | 'complete';
  requestId: string;
  command: string;
  result?: unknown;        // The eval() output from the game
  error?: string | null;   // Error message if command failed
  executedAt?: number;     // Game tick when executed
  sentAt?: number;
  timestamp?: number;      // Real-world timestamp
}

// Response from GET /debug/positions (segment 92)
export interface PositionData {
  room: string;
  startTick: number;
  entries: PositionEntry[];
}

export interface PositionEntry {
  t: number;    // tick
  c: string;    // creep name (last 6 chars)
  x: number;
  y: number;
  r: string;    // role abbreviation (3 chars): HAR, HAU, UPG, BUI, DEF, etc.
}

// Command history entry stored in localStorage
export interface HistoryEntry {
  command: string;
  timestamp: number;
  requestId: string;
  success: boolean;
}
