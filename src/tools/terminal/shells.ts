import { execa, type ResultPromise } from 'execa';
import net from 'node:net';
import { ToolCall, ToolContext, ToolResult, ok, fail } from '../types.js';

interface ManagedShell {
  id: string;
  name: string;
  command: string;
  child: ResultPromise;
  buffer: string[];
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
}

const shells = new Map<string, ManagedShell>();
let counter = 0;
const MAX_BUFFER_LINES = 400;

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.env.FREEGENT_ANDROID !== '1' && process.platform === 'win32') {
    void execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
}

function push(shell: ManagedShell, chunk: Buffer | string): void {
  const lines = chunk.toString().split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    shell.buffer.push(line);
  }
  if (shell.buffer.length > MAX_BUFFER_LINES) {
    shell.buffer.splice(0, shell.buffer.length - MAX_BUFFER_LINES);
  }
}

/** Start a background shell; output is captured, process keeps running. */
export function startShell(command: string, name: string, cwd: string): ManagedShell {
  counter++;
  const id = `sh${counter}`;
  const child = execa(command, { shell: true, cwd, reject: false, all: true, buffer: false });
  const shell: ManagedShell = {
    id, name: name || id, command, child,
    buffer: [], startedAt: Date.now(), exited: false, exitCode: null,
  };
  child.all?.on('data', (c: Buffer) => push(shell, c));
  void child.then((r) => { shell.exited = true; shell.exitCode = r.exitCode ?? null; });
  shells.set(id, shell);
  return shell;
}

export function findShell(key: string): ManagedShell | undefined {
  if (shells.has(key)) return shells.get(key);
  for (const s of shells.values()) {
    if (s.name === key) return s;
  }
  return undefined;
}

export function listShells(): ManagedShell[] {
  return [...shells.values()];
}

export function runningCount(): number {
  return listShells().filter((s) => !s.exited).length;
}

export function stopShell(key: string): boolean {
  const s = findShell(key);
  if (!s) return false;
  killTree(s.child.pid);
  s.exited = true;
  shells.delete(s.id);
  return true;
}

/** Kill every managed shell (called on app exit). */
export function stopAllShells(): void {
  for (const s of shells.values()) killTree(s.child.pid);
  shells.clear();
}

/**
 * Agent tool: persistent background shells for servers and watchers.
 * start / log / stop / list - the process KEEPS RUNNING between steps and
 * after the task ends, so the user can actually use what was started.
 */
export async function shellTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = String(call.action ?? '');
  switch (action) {
    case 'start': {
      const command = String(call.command ?? '');
      if (!command) return fail('shell start: "command" is required');
      const name = String(call.name ?? '').trim();
      const shell = startShell(command, name, ctx.cwd);
      const report = await startupReport(shell);
      return shell.exited
        ? fail(`shell "${shell.name}" ${report}`)
        : ok(`shell "${shell.name}" (${shell.id}) RUNNING in background (stays alive after this task). ${report}`);
    }
    case 'log': {
      const s = findShell(String(call.name ?? call.id ?? ''));
      if (!s) return fail(`shell log: no shell "${String(call.name ?? call.id ?? '')}" - use action "list"`);
      const n = Math.min(Number(call.lines) || 40, MAX_BUFFER_LINES);
      const state = s.exited ? `EXITED (code ${s.exitCode})` : 'running';
      return ok(`shell "${s.name}" [${state}] last ${n} lines:\n${s.buffer.slice(-n).join('\n') || '(no output)'}`);
    }
    case 'stop': {
      const key = String(call.name ?? call.id ?? '');
      return (await stopShellAndWait(key))
        ? ok(`shell "${key}" stopped.`)
        : fail(`shell stop: no shell "${key}"`);
    }
    case 'list': {
      const all = listShells();
      if (all.length === 0) return ok('No background shells.');
      const lines = all.map((s) => {
        const age = Math.round((Date.now() - s.startedAt) / 1000);
        return `${s.id} "${s.name}" [${s.exited ? `exited ${s.exitCode}` : 'running'}] ${age}s - ${s.command}`;
      });
      return ok(lines.join('\n'));
    }
    default:
      return fail(`shell: unknown action "${action}" (start|log|stop|list)`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ports mentioned in the shell's output (localhost:3000, "port 3001", ...). */
export function detectPorts(shell: ManagedShell): number[] {
  const text = shell.buffer.join(' ');
  const ports = new Set<number>();
  const patterns = [
    /localhost:([0-9]{2,5})/g,
    /127[.]0[.]0[.]1:([0-9]{2,5})/g,
    /(?:port|PORT)[ :]+([0-9]{2,5})/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const p = Number(m[1]);
      if (p > 0 && p < 65536) ports.add(p);
    }
  }
  return [...ports];
}

function tryPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v: boolean): void => { sock.destroy(); resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1500, () => done(false));
  });
}

/**
 * Wait until the shell's server is ACTUALLY ready: ports it announced are
 * accepting connections. Prevents testing against a still-booting server.
 */
export async function startupReport(shell: ManagedShell, maxWaitMs = 18_000): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && shell.buffer.length === 0 && !shell.exited) {
    await sleep(400);
  }
  const ready: number[] = [];
  let seen: number[] = [];
  while (Date.now() < deadline && !shell.exited) {
    seen = detectPorts(shell);
    for (const p of seen) {
      if (!ready.includes(p) && (await tryPort(p))) ready.push(p);
    }
    if (seen.length > 0 && ready.length === seen.length) break;
    await sleep(600);
  }
  const tail = shell.buffer.slice(-25).join('\n') || '(no output yet)';
  if (shell.exited) return `EXITED with code ${shell.exitCode}:\n${tail}`;
  let status: string;
  if (ready.length > 0) {
    status = `READY - accepting connections on port(s) ${ready.join(', ')}. Safe to test now.`;
  } else if (seen.length > 0) {
    status = `WARNING: output mentions port(s) ${seen.join(', ')} but nothing accepts connections yet - run shell log and wait before testing.`;
  } else {
    status = 'No port detected in output (may not be a server).';
  }
  return `${status}\nStartup output:\n${tail}`;
}

/** Stop and WAIT until the process tree is really dead (ports freed). */
export async function stopShellAndWait(key: string): Promise<boolean> {
  const s = findShell(key);
  if (!s) return false;
  killTree(s.child.pid);
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !s.exited) await sleep(300);
  await sleep(500); // let the OS release the ports
  s.exited = true;
  shells.delete(s.id);
  return true;
}