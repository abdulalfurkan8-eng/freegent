import type { ToolCall } from '../tools/types.js';
import { z } from 'zod';
const ToolCallSchema = z.object({ tool: z.string().min(1) }).passthrough();

/**
 * TWO accepted formats:
 *
 * 1) RAW-BLOCK (preferred) - code stays raw, NO JSON escaping:
 *      tool: write_file
 *      path: src/app.js
 *      <<<CONTENT
 *      ...raw file bytes, quotes and newlines untouched...
 *      CONTENT>>>
 *
 * 2) JSON fallback (legacy) - a fenced ```freegent {...}``` block.
 *
 * The raw-block format removes the single biggest source of failure:
 * putting whole source files inside JSON strings.
 */

const FENCED_RE = /```freegent\s*([\s\S]*?)```/i;
const BLOCK_OPEN = '<<<CONTENT';
const BLOCK_CLOSE = 'CONTENT>>>';

/** Keys that take a raw multi-line body via <<<CONTENT ... CONTENT>>>. */
const BODY_KEY: Record<string, string> = {
  write_file: 'content',
  append_file: 'content',
  edit_file: 'replace', // find comes from a header line; replace is the body
  // Header values are single-line, so a long summary would be cut at line 1.
  finish: 'summary',
};

/** Parse "key: value" headers until the first blank line or block opener. */
function parseHeaders(lines: string[]): { headers: Record<string, string>; rest: number } {
  const headers: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' ) { i++; break; }
    if (line.startsWith(BLOCK_OPEN)) break;
    const m = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (!m) break;
    headers[m[1].toLowerCase()] = m[2].trim();
  }
  return { headers, rest: i };
}

/** Extract the raw body between <<<CONTENT and CONTENT>>>. */
function extractBody(text: string, from: number): { body: string; found: boolean } {
  const open = text.indexOf(BLOCK_OPEN, from);
  if (open === -1) return { body: '', found: false };
  const bodyStart = text.indexOf('\n', open);
  if (bodyStart === -1) return { body: '', found: false };
  const close = text.indexOf(BLOCK_CLOSE, bodyStart);
  if (close === -1) return { body: '', found: false };
  // Drop the single newline that precedes CONTENT>>>, keep everything else raw.
  let body = text.slice(bodyStart + 1, close);
  body = body.replace(/\n$/, '');
  return { body, found: true };
}

/** Try the raw-block format. Returns a ToolCall or null. */
function parseRawBlock(reply: string): ToolCall | null {
  // Prefer the freegent-fenced region (protected from markdown mangling);
  // fall back to the whole reply for fences stripped by innerText.
  const fenced = reply.match(FENCED_RE);
  const scope = fenced ? fenced[1] : reply;
  const idx = scope.search(/^tools*:/im);
  if (idx === -1) return null;
  const region = scope.slice(idx);
  const lines = region.split('\n');
  const { headers } = parseHeaders(lines);
  if (!headers.tool) return null;

  const call: ToolCall = { tool: headers.tool };
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'tool') continue;
    if (k === 'all') call.all = v === 'true';
    else if (k === 'paths') call.paths = v.split(',').map((s) => s.trim()).filter(Boolean);
    else call[k] = v;
  }

  const bodyKey = BODY_KEY[headers.tool];
  if (bodyKey) {
    const { body, found } = extractBody(region, 0);
    if (found) call[bodyKey] = body;
    else if (/^[|>][+-]?$/.test(String(call[bodyKey] ?? ''))) {
      // YAML block scalar: "summary: |" (or |- |+ > >- >+) with the real
      // text on the lines below. Models fall back to this constantly -
      // honour it instead of returning the literal indicator as payload.
      const scalarRe = new RegExp(`^${bodyKey}\\s*:\\s*[|>][+-]?\\s*$`);
      const start = lines.findIndex((l) => scalarRe.test(l.trim()));
      if (start !== -1) {
        const kept: string[] = [];
        for (const l of lines.slice(start + 1)) {
          if (/^[A-Za-z_]+\s*:/.test(l)) break; // next header at column 0
          kept.push(l);
        }
        const indents = kept.filter((l) => l.trim())
          .map((l) => (/^\s*/.exec(l) ?? [''])[0].length);
        const cut = indents.length ? Math.min(...indents) : 0;
        const text = kept.map((l) => l.slice(cut)).join('\n').trim();
        if (text) call[bodyKey] = text;
      }
    }
  }
  return call;
}

/** Extract balanced {...} JSON candidates that contain a "tool" key. */
function jsonCandidates(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          if (candidate.includes('"tool"')) found.push(candidate);
          i = j;
          break;
        }
      }
    }
  }
  return found;
}

function repairJson(candidate: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (ch === '\\') { out += ch + (candidate[i + 1] ?? ''); i++; continue; }
      if (ch === '"') inStr = false;
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += '\\t'; continue; }
    } else if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

function parseJsonCall(reply: string): ToolCall | null {
  const fenced = reply.match(FENCED_RE);
  const texts = fenced ? [fenced[1], reply] : [reply];
  for (const text of texts) {
    const candidates = jsonCandidates(text);
    for (let i = candidates.length - 1; i >= 0; i--) {
      for (const attempt of [candidates[i], repairJson(candidates[i])]) {
        try {
          const parsed = JSON.parse(attempt) as ToolCall;
          const safe = ToolCallSchema.safeParse(parsed);
          if (safe.success) return safe.data as ToolCall;
        } catch { continue; }
      }
    }
  }
  return null;
}

/**
 * Models often wrap the finish summary in a JSON-style quoted string, so the
 * user sees literal \n and \" instead of real line breaks. Unescape it. Only
 * finish is treated - unescaping write_file content would corrupt real code.
 */
function cleanSummary(call: ToolCall): ToolCall {
  if (call.tool !== 'finish' || typeof call.summary !== 'string') return call;
  let s = call.summary.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
    try {
      s = JSON.parse(s) as string;
    } catch {
      s = s.slice(1, -1); // unbalanced escapes - strip quotes, decode below
    }
  }
  if (!s.includes('\n') && s.includes('\\n')) {
    s = s.replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  }
  call.summary = s;
  return call;
}

/** Parse a tool call: raw-block first, JSON fallback second. */
export function parseToolCall(reply: string): ToolCall | null {
  const call = parseRawBlock(reply) ?? parseJsonCall(reply);
  return call ? cleanSummary(call) : null;
}

/**
 * True when the reply clearly TRIED a call but never closed it: a raw block
 * opened without its CONTENT>>> terminator, or a "tool" JSON that never
 * balanced. Signature of the chat UI truncating an over-long message.
 */
export function looksTruncated(reply: string): boolean {
  if (reply.includes(BLOCK_OPEN) && !reply.includes(BLOCK_CLOSE)) return true;
  const marker = reply.lastIndexOf('"tool"');
  if (marker === -1) return false;
  const tail = reply.slice(marker);
  let depth = 1;
  let inStr = false;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return false; }
  }
  return true;
}

/**
 * Oversized feedback stalls the DeepSeek composer: past its input limit,
 * Enter is silently ignored and sendPrompt dies with "composer never
 * cleared". Keep head + tail so page content and trailing errors survive.
 */
const MAX_FEEDBACK = 6000;

export function formatToolResult(ok: boolean, output: string): string {
  let body = output;
  if (body.length > MAX_FEEDBACK) {
    const head = body.slice(0, MAX_FEEDBACK - 1200);
    const tail = body.slice(-800);
    body = `${head}\n...[${output.length - MAX_FEEDBACK} chars omitted]...\n${tail}`;
  }
  return [
    `Tool result: ${ok ? 'success' : 'failure'}`,
    '```text',
    body,
    '```',
    'Continue. Emit exactly ONE next tool call inside a fenced freegent block.',
  ].join('\n');
}