import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { ToolCall } from '../tools/types.js';

/** One hook: run `command` when a matching tool fires. */
interface HookDef {
  tools: string[];
  command: string;
}

/** Shape of <project>/.freegent/hooks.json */
export interface HooksFile {
  pre?: HookDef[];
  post?: HookDef[];
  /** Regex (or substring) patterns for paths the agent may never modify. */
  protect?: string[];
}

async function loadHooks(cwd: string): Promise<HooksFile> {
  try {
    const raw = await readFile(join(cwd, '.freegent', 'hooks.json'), 'utf8');
    return JSON.parse(raw) as HooksFile;
  } catch {
    return {};
  }
}

/** True if project settings forbid the agent from touching this path. */
export async function isProtected(path: string, cwd: string): Promise<boolean> {
  const hooks = await loadHooks(cwd);
  return (hooks.protect ?? []).some((p) => {
    try {
      return new RegExp(p).test(path);
    } catch {
      return path.includes(p);
    }
  });
}

export interface HookOutcome {
  blocked: boolean;
  output: string;
}

/** Run pre/post hooks matching a tool call. A failing pre-hook blocks it. */
export async function runHooks(
  stage: 'pre' | 'post',
  call: ToolCall,
  cwd: string,
): Promise<HookOutcome> {
  const hooks = await loadHooks(cwd);
  const defs = (stage === 'pre' ? hooks.pre : hooks.post) ?? [];
  const outputs: string[] = [];
  for (const def of defs) {
    if (!Array.isArray(def.tools) || !def.tools.includes(call.tool)) continue;
    const r = await execa(def.command, {
      shell: true,
      cwd,
      reject: false,
      timeout: 60_000,
      env: {
        ...process.env,
        FREEGENT_TOOL: call.tool,
        FREEGENT_PATH: String(call.path ?? ''),
      },
    });
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
    if (out) outputs.push(out);
    if (stage === 'pre' && r.exitCode !== 0) {
      return { blocked: true, output: out || `hook "${def.command}" exited ${r.exitCode}` };
    }
  }
  return { blocked: false, output: outputs.join('\n') };
}