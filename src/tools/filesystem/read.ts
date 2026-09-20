import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ToolCall, ToolContext, ToolResult, ok, fail } from '../types.js';
import { DEFAULTS } from '../../config/defaults.js';
const MAX_BYTES = DEFAULTS.agent.maxReadableFileBytes;
export async function readFileTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const path = String(call.path ?? ''); if (!path) return fail('read_file: "path" is required');
  const abs=resolve(ctx.cwd,path); let fh: Awaited<ReturnType<typeof open>>|undefined;
  try { const info=await (await import('node:fs/promises')).stat(abs); if(!info.isFile()) return fail(`read_file: ${path} is not a file`); const size=Math.min(info.size,MAX_BYTES); fh=await open(abs,'r'); const buf=Buffer.alloc(size); const {bytesRead}=await fh.read(buf,0,size,0); const text=buf.subarray(0,bytesRead).toString('utf8'); return ok(info.size>MAX_BYTES?`[truncated to ${MAX_BYTES} bytes of ${info.size}]\n${text}`:text); }
  catch(err){return fail(`read_file: cannot read ${path}: ${(err as Error).message}`)} finally {await fh?.close().catch(()=>undefined)}
}
