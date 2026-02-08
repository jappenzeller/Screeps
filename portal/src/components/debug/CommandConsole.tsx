import { useState, useRef, useEffect, useCallback } from 'react';
import { postCommand, fetchCommandResult } from '../../api/debug';
import type { HistoryEntry } from '../../types/debug';

const HISTORY_KEY = 'screeps-portal-cmd-history';
const MAX_HISTORY = 50;

const QUICK_COMMANDS = [
  { label: 'CPU Stats', command: 'JSON.stringify({ used: Game.cpu.getUsed(), bucket: Game.cpu.bucket, limit: Game.cpu.limit })' },
  { label: 'Energy Stats', command: '(() => { const rooms = Object.values(Game.rooms).filter(r => r.controller?.my); return JSON.stringify(rooms.map(r => ({ room: r.name, available: r.energyAvailable, capacity: r.energyCapacityAvailable, storage: r.storage?.store.energy }))); })()' },
  { label: 'Creep Counts', command: 'JSON.stringify(Object.values(Game.creeps).reduce((a, c) => { a[c.memory.role] = (a[c.memory.role]||0)+1; return a }, {}))' },
  { label: 'Empire State', command: 'JSON.stringify(Memory.empire?.state)' },
  { label: 'Memory Size', command: 'JSON.stringify({ bytes: RawMemory.get().length, kb: (RawMemory.get().length/1024).toFixed(1) })' },
];

interface OutputEntry {
  command: string;
  result?: unknown;
  error?: string;
  tick?: number;
  pending?: boolean;
}

function highlightJson(json: string): string {
  // Sanitize < and > first
  const sanitized = json.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return sanitized
    .replace(/"([^"]+)":/g, '<span style="color:#88aaff">"$1"</span>:')     // keys
    .replace(/: "([^"]*)"(,?)/g, ': <span style="color:#88ff88">"$1"</span>$2')  // string values
    .replace(/: (\d+\.?\d*)(,?)/g, ': <span style="color:#ffcc00">$1</span>$2')  // numbers
    .replace(/: (true|false)(,?)/g, ': <span style="color:#ff8844">$1</span>$2') // booleans
    .replace(/: (null)(,?)/g, ': <span style="color:#888888">$1</span>$2');       // null
}

function formatResult(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    // Try to parse as JSON for formatting
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function loadHistory(): HistoryEntry[] {
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (!stored) return [];
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

function saveHistory(history: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  } catch {
    // Ignore storage errors
  }
}

export function CommandConsole() {
  const [input, setInput] = useState('');
  const [shard, setShard] = useState('shard0');
  const [outputs, setOutputs] = useState<OutputEntry[]>([]);
  const [executing, setExecuting] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when new output is added
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputs]);

  const executeCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim() || executing) return;

    setExecuting(true);
    setInput('');
    setHistoryIndex(-1);

    // Add pending entry to output
    setOutputs(prev => [...prev, { command: cmd, pending: true }]);

    try {
      // Queue the command
      const queueResponse = await postCommand(cmd, shard);

      if (!queueResponse.data.success) {
        setOutputs(prev => prev.map((o, i) =>
          i === prev.length - 1 ? { ...o, error: queueResponse.data.error || 'Failed to queue command', pending: false } : o
        ));
        setExecuting(false);
        return;
      }

      const requestId = queueResponse.data.requestId;

      // Add to history
      const newEntry: HistoryEntry = {
        command: cmd,
        timestamp: Date.now(),
        requestId,
        success: true,
      };
      const newHistory = [newEntry, ...history.filter(h => h.command !== cmd)];
      setHistory(newHistory);
      saveHistory(newHistory);

      // Poll for result
      let attempts = 0;
      const maxAttempts = 10;
      const pollInterval = 3000;

      const poll = async () => {
        attempts++;
        try {
          const resultResponse = await fetchCommandResult(requestId);
          const result = resultResponse.data;

          if (result.status === 'complete') {
            setOutputs(prev => prev.map((o, i) =>
              i === prev.length - 1 ? {
                command: cmd,
                result: result.result,
                error: result.error || undefined,
                tick: result.executedAt,
                pending: false
              } : o
            ));
            setExecuting(false);
            return;
          }

          if (attempts < maxAttempts) {
            setTimeout(poll, pollInterval);
          } else {
            setOutputs(prev => prev.map((o, i) =>
              i === prev.length - 1 ? {
                ...o,
                error: 'Command still pending — the game tick may not have processed yet. You can check again later.',
                pending: false
              } : o
            ));
            setExecuting(false);
          }
        } catch (err) {
          setOutputs(prev => prev.map((o, i) =>
            i === prev.length - 1 ? { ...o, error: `Poll error: ${err}`, pending: false } : o
          ));
          setExecuting(false);
        }
      };

      setTimeout(poll, pollInterval);
    } catch (err) {
      setOutputs(prev => prev.map((o, i) =>
        i === prev.length - 1 ? { ...o, error: `Error: ${err}`, pending: false } : o
      ));
      setExecuting(false);
    }
  }, [executing, shard, history]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      executeCommand(input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
      setHistoryIndex(newIndex);
      setInput(history[newIndex].command);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setInput('');
      } else {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(history[newIndex].command);
      }
    }
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem(HISTORY_KEY);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Quick commands */}
      <div className="flex flex-wrap gap-2 mb-3">
        {QUICK_COMMANDS.map((qc) => (
          <button
            key={qc.label}
            type="button"
            onClick={() => executeCommand(qc.command)}
            disabled={executing}
            className="px-2 py-1 text-xs border border-[#444] rounded hover:bg-[#333] hover:border-[#666] disabled:opacity-50 transition-colors"
          >
            {qc.label}
          </button>
        ))}
      </div>

      {/* Output area */}
      <div
        ref={outputRef}
        className="flex-1 overflow-y-auto bg-[#0a0a0a] border border-[#333] rounded p-3 mb-3 font-mono text-sm"
      >
        {outputs.length === 0 && (
          <div className="text-[#666] text-center py-8">
            Enter a command below to execute it in the Screeps console
          </div>
        )}
        {outputs.map((entry, i) => (
          <div key={i} className="mb-4 last:mb-0">
            {/* Command line */}
            <div className="text-[#00ff88]">
              <span className="text-[#888]">&gt;</span> {entry.command}
            </div>

            {/* Result or status */}
            {entry.pending ? (
              <div className="text-[#888] mt-1 flex items-center gap-2">
                <span className="w-3 h-3 border border-[#4488ff] border-t-transparent rounded-full animate-spin" />
                <span>Waiting for execution...</span>
              </div>
            ) : entry.error ? (
              <div className="mt-1">
                <div className="text-[#666] text-xs mb-1">─── Error ───</div>
                <div className="text-[#ff4444] whitespace-pre-wrap">{entry.error}</div>
              </div>
            ) : (
              <div className="mt-1">
                <div className="text-[#666] text-xs mb-1">
                  ─── Result{entry.tick ? ` (tick ${entry.tick.toLocaleString()})` : ''} ───
                </div>
                <pre
                  className="text-[#ccc] whitespace-pre-wrap overflow-x-auto"
                  dangerouslySetInnerHTML={{ __html: highlightJson(formatResult(entry.result)) }}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input area */}
      <div className="flex gap-2 items-center">
        <span className="text-[#888] font-mono">&gt;</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={executing}
          placeholder="Enter command..."
          className="flex-1 bg-[#1a1a1a] border border-[#333] rounded px-3 py-2 font-mono text-[#00ff88] placeholder-[#555] focus:outline-none focus:border-[#00ff88] disabled:opacity-50"
        />
        <select
          value={shard}
          onChange={(e) => setShard(e.target.value)}
          className="bg-[#1a1a1a] border border-[#333] rounded px-2 py-2 text-sm text-[#888] focus:outline-none focus:border-[#555]"
        >
          <option value="shard0">shard0</option>
          <option value="shard1">shard1</option>
          <option value="shard2">shard2</option>
          <option value="shard3">shard3</option>
        </select>
        <button
          type="button"
          onClick={() => executeCommand(input)}
          disabled={executing || !input.trim()}
          className="px-4 py-2 bg-[#00ff88] text-black font-medium rounded hover:bg-[#00dd77] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Run
        </button>
      </div>

      {/* History chips */}
      {history.length > 0 && (
        <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-2">
          <span className="text-xs text-[#666] flex-shrink-0">History:</span>
          {history.slice(0, 10).map((entry, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setInput(entry.command)}
              className="px-2 py-1 text-xs bg-[#222] border border-[#333] rounded hover:bg-[#333] truncate max-w-[200px] flex-shrink-0"
              title={entry.command}
            >
              {entry.command.length > 30 ? entry.command.slice(0, 30) + '...' : entry.command}
            </button>
          ))}
          <button
            type="button"
            onClick={clearHistory}
            className="px-2 py-1 text-xs text-[#888] hover:text-[#ff4444] flex-shrink-0"
            title="Clear history"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
