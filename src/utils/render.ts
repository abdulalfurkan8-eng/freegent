import chalk from 'chalk';

/** Color per tool family: reads blue, writes yellow, exec magenta, etc. */
const TOOL_COLOR: Record<string, (s: string) => string> = {
  read_file: chalk.blue, list_dir: chalk.blue, search: chalk.blue,
  web_fetch: chalk.blue,
  write_file: chalk.yellow, edit_file: chalk.yellow,
  delete_file: chalk.red,
  run_command: chalk.magenta, git: chalk.cyan, todo: chalk.green,
};

/** Claude Code style tool call line, indented under the current step. */
export function renderToolCall(tool: string, detail: string): void {
  const short = detail.length > 70 ? detail.slice(0, 67) + '...' : detail;
  const paint = TOOL_COLOR[tool] ?? chalk.green;
  console.log('  ' + paint('●'), chalk.bold(tool) + chalk.dim(`(${short})`));
}

/** Result line nested under its call:  ⎿ summary. A `display` diff ("+42 −0") wins. */
export function renderToolResult(output: string, ok: boolean, display?: string): void {
  if (ok && display) {
    const colored = display
      .replace(/\+\d+/, (m) => chalk.green(m))
      .replace(/−\d+/, (m) => chalk.red(m))
      .replace(/▎.*$/, (m) => chalk.blueBright(m));
    console.log('    ' + chalk.dim('⎿ ') + colored);
    return;
  }
  const lines = output.split('\n');
  const first = lines.find((l) => l.trim().length > 0)?.trim() ?? '';
  const head = first.length > 90 ? first.slice(0, 87) + '...' : first;
  const extra = lines.length > 1 ? ` ${chalk.dim(`(+${lines.length - 1} lines)`)}` : '';
  const body = ok ? chalk.dim(head) : chalk.red(head);
  console.log('    ' + (ok ? chalk.dim('⎿ ') : chalk.red('⎿ ')) + body + extra);
}

/** Lightweight markdown styling for terminal display. */
function styleLine(line: string): string {
  if (/^#{1,6}\s/.test(line)) {
    return chalk.bold.cyan(line.replace(/^#{1,6}\s+/, ''));
  }
  let l = line.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => chalk.bold.white(t));
  l = l.replace(/`([^`]+)`/g, (_m, t: string) => chalk.yellow(t));
  l = l.replace(/^(\s*)[-*]\s+/, (_m, sp: string) => `${sp}${chalk.cyan('•')} `);
  return l;
}

let _lastCollapsed = '';
export function getLastCollapsed(): string { return _lastCollapsed; }

/** Render assistant prose (text outside the tool JSON) with md styling.
 *  Fenced code blocks are collapsed to a one-line chip; Ctrl+O expands the last one. */
export function renderAssistantText(reply: string): void {
  const stripped = reply
    .replace(/```freegent[\s\S]*?```/gi, '')
    .replace(/<freegent>[\s\S]*?<[/]freegent>/gi, '')
    .replace(/^freegent$/gim, '')
    .replace(/^(Copy|Download)$/gim, '')
    .replace(/^tool\s*:[\s\S]*/im, '')
    .replace(/\{[\s\S]*"tool"[\s\S]*\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!stripped) return;

  // Collapse fenced code blocks into chips; save last one for Ctrl+O expand.
  let collapsedCode = '';
  const cleaned = stripped.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    collapsedCode = body.trimEnd();
    const lines = body.trim().split('\n').length;
    const tag = lang || 'code';
    return chalk.dim('[') + chalk.blueBright(tag) + chalk.dim(` · ${lines} line${lines === 1 ? '' : 's'} — Ctrl+O to expand`) + chalk.dim(']');
  });
  if (collapsedCode) _lastCollapsed = collapsedCode;

  console.log('');
  for (const line of cleaned.split('\n')) console.log(styleLine(line));
  console.log('');
}

/** Summarize a tool call's main argument for display. */
export function describeCall(call: Record<string, unknown>): string {
  const keys = ['path', 'command', 'query', 'url', 'action', 'summary'];
  for (const k of keys) {
    if (typeof call[k] === 'string' && (call[k] as string).length > 0) {
      return call[k] as string;
    }
  }
  if (Array.isArray(call.paths)) return `${call.paths.length} files`;
  if (Array.isArray(call.items)) return `${call.items.length} items`;
  return '';
}

/** Compact one-line step for read-only ops: "  · read_file src/x.ts — 47 lines" */
export function renderCompactStep(
  tool: string,
  detail: string,
  output: string,
  ok: boolean,
): void {
  const short = detail.length > 60 ? detail.slice(0, 57) + '...' : detail;
  const lines = output.split('\n').length;
  const status = ok
    ? chalk.dim(`${lines} line${lines === 1 ? '' : 's'}`)
    : chalk.red('failed');
  console.log(chalk.dim(`    · ${tool} `) + chalk.white.dim(short) + chalk.dim(' — ') + status);
}

/** mm:ss for a millisecond duration. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Live countdown while a foreground command runs: "⏱ 0:07 / 2:00  running…".
 * Rewrites ONE line in place with \r - no cursor save/restore and no vertical
 * movement, so it stays safe on Termux and cannot corrupt the input box.
 * No-op when stdout is not a TTY. Returns a stop() that clears the line.
 */
export function startCommandTimer(command: string, timeoutMs: number): () => void {
  if (!process.stdout.isTTY) return () => undefined;
  const started = Date.now();
  const cols = process.stdout.columns ?? 80;
  const label = command.length > 34 ? command.slice(0, 31) + '...' : command;
  const paint = (): void => {
    const elapsed = Date.now() - started;
    const near = elapsed > timeoutMs * 0.75;
    const time = `${clock(elapsed)} / ${clock(timeoutMs)}`;
    const pulse = Math.floor(elapsed / 180) % 6;
    const glyph = ['◐','◓','◑','◒','◐','◒'][pulse];
    const line =
      '    ' + chalk.dim('> ') + (near ? chalk.yellow(glyph + ' ') : chalk.blueBright(glyph + ' ')) +
      chalk.white(time) + chalk.dim(`  ${label}`);
    process.stdout.write('\r' + line.slice(0, cols + 40));
  };
  paint();
  const tick = setInterval(paint, 180);
  return () => {
    clearInterval(tick);
    process.stdout.write('\r' + ' '.repeat(Math.max(0, cols - 1)) + '\r');
  };
}