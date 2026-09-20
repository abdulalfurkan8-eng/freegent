import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

/** Syntax-check files: node --check for JS, JSON.parse, HTML tag balance. */
export async function checkTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const paths = Array.isArray(call.paths)
    ? call.paths.map(String)
    : call.path
      ? [String(call.path)]
      : [];
  if (paths.length === 0) return fail('check: provide "paths" (array of files)');

  const problems: string[] = [];
  const passed: string[] = [];
  for (const p of paths) {
    const abs = resolve(ctx.cwd, p);
    const ext = extname(abs).toLowerCase();
    try {
      if (['.js', '.mjs', '.cjs'].includes(ext)) {
        const r = await execa('node', ['--check', abs], { reject: false });
        if (r.exitCode === 0) passed.push(p);
        else problems.push(`${p}:\n${(r.stderr || 'syntax error').slice(0, 800)}`);
      } else if (ext === '.json') {
        JSON.parse(await readFile(abs, 'utf8'));
        passed.push(p);
      } else if (ext === '.css') {
        const css = await readFile(abs, 'utf8');
        const opens = (css.match(/[{]/g) ?? []).length;
        const closes = (css.match(/[}]/g) ?? []).length;
        if (opens !== closes) {
          problems.push(p + ': unbalanced braces (' + opens + ' open vs ' + closes + ' close) - file may be truncated');
        } else passed.push(p);
      } else if (['.html', '.htm'].includes(ext)) {
        const html = await readFile(abs, 'utf8');
        const opens = (html.match(/<script\b/gi) ?? []).length;
        const closes = (html.match(/<\/script>/gi) ?? []).length;
        if (opens !== closes) {
          problems.push(`${p}: unbalanced <script> tags (${opens} open, ${closes} close)`);
        } else passed.push(p);
      } else {
        passed.push(`${p} (no syntax checker for "${ext}" — verify via run_command build/tests)`);
      }
    } catch (err) {
      problems.push(`${p}: ${(err as Error).message}`);
    }
  }
  const summary = `checked ${paths.length}: ${passed.length} ok, ${problems.length} failed`;
  if (problems.length > 0) return fail(`${summary}\n\n${problems.join('\n\n')}`);
  return ok(`${summary}\n${passed.join('\n')}`);
}