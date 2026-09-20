import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

interface PackageManifest { scripts?: Record<string, string>; dependencies?: Record<string,string>; devDependencies?: Record<string,string>; packageManager?: string; }

/** Deterministic project-health snapshot for proactive debugging. */
export async function projectHealthTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const root = ctx.cwd;
  const findings: string[] = [];
  let manifest: PackageManifest | null = null;
  try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageManifest; } catch {}

  if (manifest) {
    const scripts = Object.keys(manifest.scripts ?? {});
    findings.push(`package.json: scripts=[${scripts.join(', ')}]`);
    const pm = manifest.packageManager ?? (scripts.length ? 'node project' : 'unknown');
    findings.push(`package manager hint: ${pm}`);
    if (!manifest.scripts?.test) findings.push('RISK: no test script is declared. Verification may need a project-specific command.');
    if (!manifest.scripts?.build) findings.push('RISK: no build script is declared. Type/build verification may need discovery.');
    if (manifest.dependencies?.typescript || manifest.devDependencies?.typescript) findings.push('TypeScript detected: prefer type-checking after source changes.');
  }

  try {
    const git = await execa('git', ['status', '--short'], { cwd: root, reject: false, timeout: 8_000 });
    if (git.exitCode === 0) {
      const lines = git.stdout.split(/\r?\n/).filter(Boolean);
      findings.push(`git working tree: ${lines.length ? `${lines.length} changed path(s)` : 'clean'}`);
      if (lines.length > 30) findings.push('RISK: many pre-existing changes; isolate task scope carefully.');
    }
  } catch {}

  const suspicious: Array<[RegExp,string]> = [
    [/eval\s*\(/i, 'possible eval()/dynamic code execution'],
    [/child_process\.(exec|execSync)\s*\(/i, 'shell execution call; validate inputs and quoting'],
    [/innerHTML\s*=/i, 'innerHTML assignment; review untrusted HTML/data flow'],
    [/password|api[_-]?key|secret/i, 'possible secret-bearing identifier; avoid printing or committing values'],
  ];
  try {
    const scan = await execa('git', ['ls-files'], { cwd: root, reject: false, timeout: 8_000 });
    if (scan.exitCode === 0) {
      const files = scan.stdout.split(/\r?\n/).filter(Boolean).slice(0, 300);
      for (const file of files) {
        if (!/[.](js|mjs|cjs|ts|tsx|jsx|py|java|cs|go|rs|php)$/.test(file)) continue;
        let text = '';
        try { text = await readFile(join(root, file), 'utf8'); } catch { continue; }
        for (const [re, msg] of suspicious) if (re.test(text)) findings.push(`REVIEW ${file}: ${msg}.`);
      }
    }
  } catch {}

  if (!findings.length) return fail('Project health could not identify a known manifest or Git project. Inspect the directory manually.');
  return ok([
    'PROJECT HEALTH SNAPSHOT',
    ...findings.slice(0, 120),
    '',
    'Use this as a risk map, not proof of correctness. For important changes, read the affected code, reproduce the issue, test the fix, and verify user-facing behavior.',
  ].join('\n'));
}
