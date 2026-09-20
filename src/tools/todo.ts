import chalk from 'chalk';
import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

type Status = 'pending' | 'doing' | 'done';
interface TodoItem { text: string; status: Status; }

let items: TodoItem[] = [];
/** True once the todo tool ran in the current task - gates the final print. */
let touched = false;

// Stable ASCII markers avoid terminal redraw artifacts and emoji-like glyph rendering.
const ICONS: Record<Status, string> = {
  pending: chalk.dim('[ ]'),
  doing: chalk.yellow('[>]'),
  done: chalk.green('[x]'),
};

export function clearTodos(): void {
  items = [];
  touched = false;
}

export function hasTodos(): boolean {
  return items.length > 0;
}

export function todoTouched(): boolean {
  return touched;
}

export function resetTodoTouch(): void {
  touched = false;
}

/** "▓▓▓▓▓▓░░░░ 3/5" progress bar for the Tasks header. */
function progressBar(): string {
  const done = items.filter((i) => i.status === 'done').length;
  const width = 10;
  const filled = Math.round((done / items.length) * width);
  const bar = chalk.blueBright('▓'.repeat(filled)) + chalk.dim('░'.repeat(width - filled));
  return `${bar} ${done}/${items.length}`;
}

/** Print the current checklist, Claude Code style. */
export function renderTodos(): void {
  if (items.length === 0) return;
  console.log(chalk.bold('\n  Tasks  ') + progressBar());
  for (const t of items) {
    const text =
      t.status === 'done'
        ? chalk.dim.strikethrough(t.text)
        : t.status === 'doing'
          ? chalk.white(t.text)
          : chalk.dim(t.text);
    console.log(`   ${ICONS[t.status]} ${text}`);
  }
  console.log('');
}

/**
 * Multi-line checklist block floated inside the working spinner (ora redraws
 * multi-line text in place, so this "overlays" without cursor tricks - the
 * same tech as the live token counter, safe on Termux).
 */
export function todoOverlay(): string {
  if (items.length === 0) return '';
  const cols = process.stdout.columns ?? 80;
  const max = Math.max(20, cols - 10);
  const lines = [chalk.bold('  Tasks  ') + progressBar()];
  for (const t of items) {
    const text = t.text.length > max ? t.text.slice(0, max - 3) + '...' : t.text;
    const painted =
      t.status === 'done'
        ? chalk.dim.strikethrough(text)
        : t.status === 'doing'
          ? chalk.white(text)
          : chalk.dim(text);
    lines.push(`   ${ICONS[t.status]} ${painted}`);
  }
  return lines.join('\n');
}

/** Agent tool: replace the whole todo list with updated statuses. */
export async function todoTool(
  call: ToolCall,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const raw = call.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail('todo: "items" must be a non-empty array of {text, status}');
  }
  const parsed: TodoItem[] = [];
  for (const it of raw) {
    const o = it as Record<string, unknown>;
    const text = String(o.text ?? '').trim();
    const status = String(o.status ?? 'pending') as Status;
    if (!text) return fail('todo: every item needs non-empty "text"');
    if (!['pending', 'doing', 'done'].includes(status)) {
      return fail(`todo: invalid status "${status}" (pending|doing|done)`);
    }
    parsed.push({ text, status });
  }
  items = parsed;
  touched = true;
  // No scrollback print here: the list floats live in the spinner overlay
  // while the task runs, and is printed as plain text once the task ends.
  const done = items.filter((i) => i.status === 'done').length;
  return ok(`Todo list updated: ${done}/${items.length} done. Keep it current as you work.`);
}