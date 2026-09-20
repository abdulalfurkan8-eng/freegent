/** A parsed tool call emitted by the model. */
export interface ToolCall {
  tool: string;
  [key: string]: unknown;
}

/** Result of executing a tool, fed back to the model. */
export interface ToolResult {
  ok: boolean;
  /** Human/model-readable output text. */
  output: string;
  /** Set when the tool signals the task is complete. */
  finished?: boolean;
  /** Optional terminal-only summary (e.g. "+42 −0  ▎new file"). Never sent to the model. */
  display?: string;
}

/** Context passed to every tool handler. */
export interface ToolContext {
  cwd: string;
  confirmCommands: boolean;
  /** Open a fresh page in the running browser (enables test_page). */
  newPage?: () => Promise<import('playwright').Page>;
  /** Aborted when the user interrupts the task - kill child processes. */
  signal?: AbortSignal;
  /** Explicit user request to use physical mouse/keyboard computer control, not application scripts. */
  computerControlOnly?: boolean;
  /** Queue an image to attach to the NEXT message sent to the model. */
  attachImage?: (path: string) => void;
  /** Run sub-agents in their own browser tabs, concurrently. */
  spawn?: (jobs: Array<{ label: string; task: string }>) =>
    Promise<Array<{ label: string; ok: boolean; output: string }>>;
  /** Incremental agent state projection for perception/control tools. */
  state?: import('../agent/state.js').AgentState;
}

/** A tool handler: takes a call + context, returns a result. */
export type ToolHandler = (
  call: ToolCall,
  ctx: ToolContext,
) => Promise<ToolResult>;

export function ok(output: string, finished = false): ToolResult {
  return { ok: true, output, finished };
}

export function fail(output: string): ToolResult {
  return { ok: false, output };
}

/**
 * "+N −M" line-diff summary between two file versions, for terminal display.
 * Counts lines that left/entered the file (multiset diff), not a full LCS -
 * cheap, and accurate enough for a one-line preview.
 */
export function diffStat(before: string | null, after: string): string {
  if (before === null) {
    return `+${after.split('\n').length} −0  ▎new file`;
  }
  const counts = new Map<string, number>();
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split('\n')) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return `+${added} −${removed}`;
}