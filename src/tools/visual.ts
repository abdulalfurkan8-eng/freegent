import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

const BASELINE_DIR = '.freegent/baselines';

/** Turn a page path/url into a safe baseline filename. */
function slug(target: string): string {
  const cleaned = target.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'page').slice(0, 60).toLowerCase();
}

/**
 * Visual regression: screenshot a page and compare it to a stored baseline.
 *   { "tool": "visual", "path": "index.html" }               -> compare (or create baseline)
 *   { "tool": "visual", "path": "index.html", "update": "true" } -> re-record baseline
 *   { "tool": "visual", "path": "index.html", "width": 390 } -> mobile viewport
 */
export async function visualTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.newPage) {
    return fail('visual: no browser available (the DeepSeek browser session is not running).');
  }
  const target = String(call.path ?? call.url ?? '').trim();
  if (!target) return fail('visual: "path" (a local html file) or "url" is required');

  const width = Math.min(Math.max(Number(call.width) || 1280, 320), 2560);
  const height = Math.min(Math.max(Number(call.height) || 800, 320), 2000);
  const update = String(call.update ?? '') === 'true';

  const url = /^https?:/i.test(target)
    ? target
    : pathToFileURL(resolve(ctx.cwd, target)).href;

  const dir = join(ctx.cwd, BASELINE_DIR);
  await mkdir(dir, { recursive: true });
  const baseline = join(dir, `${slug(target)}-${width}x${height}.png`);

  const page = await ctx.newPage();
  let shot: Buffer;
  try {
    await page.setViewportSize({ width, height });
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(Math.min(Number(call.waitMs) || 600, 10_000));
    shot = await page.screenshot({ fullPage: false });
  } catch (err) {
    await page.close().catch(() => undefined);
    return fail(`visual: cannot render ${target}: ${(err as Error).message}`);
  }

  const visualReview = await inspectVisualHeuristics(page).catch(() => ({ flags: [] as string[] }));

  let hasBaseline = true;
  try { await access(baseline); } catch { hasBaseline = false; }

  if (!hasBaseline || update) {
    await writeFile(baseline, shot);
    await page.close().catch(() => undefined);
    ctx.attachImage?.(baseline);
    return ok(
      `visual: baseline ${hasBaseline ? 're-recorded' : 'recorded'} at ${BASELINE_DIR}/` +
        `${slug(target)}-${width}x${height}.png (${width}x${height}). ` +
        'The image is ATTACHED - inspect the actual design before continuing. ' +
        formatVisualReview(visualReview.flags),
    );
  }

  const before = await readFile(baseline);
  const diff = await comparePng(page, before, shot);
  const current = join(dir, `${slug(target)}-${width}x${height}-current.png`);
  await writeFile(current, shot);
  await page.close().catch(() => undefined);

  if (diff.percent === 0) {
    // Attach it anyway: "identical to a baseline I recorded seconds ago"
    // proves nothing about whether the page actually looks right. The
    // model must SEE it before it can say the work is verified.
    ctx.attachImage?.(current);
    return ok(
      `visual: ${target} at ${width}x${height} rendered and is pixel-identical ` +
        'to the stored baseline. The CURRENT screenshot is ATTACHED - LOOK at ' +
        'it and describe what you actually see before saying the page is ' +
        'correct. Matching a baseline is not proof the page is right. ' +
      formatVisualReview(visualReview.flags),
    );
  }
  ctx.attachImage?.(current);
  const verdict = diff.percent < 0.1 ? 'tiny' : diff.percent < 2 ? 'noticeable' : 'large';
  return ok(
    `visual: CHANGED - ${diff.percent.toFixed(2)}% of pixels differ (${verdict}) ` +
      `for ${target} at ${width}x${height}.\n` +
      `Changed region: x ${diff.minX}-${diff.maxX}, y ${diff.minY}-${diff.maxY}.\n` +
      'The CURRENT screenshot is ATTACHED - look at it. If this change is what you ' +
      `intended, re-record with {"tool":"visual","path":"${target}","update":"true"}. ` +
      'If not, you broke the layout - fix it. ' + formatVisualReview(visualReview.flags),
  );
}

function formatVisualReview(flags: string[]): string {
  return flags.length
    ? `\nDESIGN_REVIEW: NEEDS_ATTENTION\n${flags.map((f) => `- ${f}`).join('\n')}\nUse the screenshot to decide the correct improvements; do not assume these heuristics are the whole review.`
    : '\nDESIGN_REVIEW: No obvious heuristic problems detected. Still inspect the screenshot yourself.';
}

async function inspectVisualHeuristics(page: import('playwright').Page): Promise<{ flags: string[] }> {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const flags: string[] = [];
    const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text);
    const lowContent = text.trim().length < 260;
    const placeholders = /lorem ipsum|your text here|placeholder|coming soon|sample text/i.test(text);
    const emptyButtons = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter((el) => !((el.textContent || '').trim() || el.getAttribute('aria-label'))).length;
    const hugeRadii = Array.from(document.querySelectorAll('*')).filter((el) => {
      const r = getComputedStyle(el).borderRadius;
      return /9999|999px|50%/.test(r);
    }).length;
    if (hasEmoji) flags.push('UI/content contains emoji-like glyphs; replace them with professional icons or typography unless explicitly requested.');
    if (placeholders) flags.push('Placeholder or filler copy detected; replace it with realistic, task-specific content.');
    if (lowContent) flags.push('Very low visible content density; make the page feel complete rather than like a starter mockup.');
    if (emptyButtons > 0) flags.push(`${emptyButtons} interactive control(s) have no visible label or aria-label.`);
    if (hugeRadii >= 6) flags.push('Many elements use pill/circular radius styling; avoid excessive rounded-card UI unless the design calls for it.');
    return { flags };
  });
}

interface DiffResult {
  percent: number; minX: number; maxX: number; minY: number; maxY: number;
}

/** Decode both PNGs in the page and compare pixels on a canvas. */
async function comparePng(
  page: import('playwright').Page,
  before: Buffer,
  after: Buffer,
): Promise<DiffResult> {
  return page.evaluate(
    async ([a, b]: [string, string]): Promise<DiffResult> => {
      const load = (data: string): Promise<HTMLImageElement> =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = () => rej(new Error('decode failed'));
          img.src = `data:image/png;base64,${data}`;
        });
      const [imgA, imgB] = await Promise.all([load(a), load(b)]);
      const w = Math.max(imgA.width, imgB.width);
      const h = Math.max(imgA.height, imgB.height);
      const grab = (img: HTMLImageElement): Uint8ClampedArray => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.clearRect(0, 0, w, h);
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, w, h).data;
      };
      const pa = grab(imgA); const pb = grab(imgB);
      let changed = 0;
      let minX = w; let maxX = 0; let minY = h; let maxY = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (Math.abs(pa[i] - pb[i]) > 8 || Math.abs(pa[i + 1] - pb[i + 1]) > 8 ||
              Math.abs(pa[i + 2] - pb[i + 2]) > 8 || Math.abs(pa[i + 3] - pb[i + 3]) > 8) {
            changed++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      const percent = (changed / (w * h)) * 100;
      return changed === 0
        ? { percent: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 }
        : { percent, minX, maxX, minY, maxY };
    },
    [before.toString('base64'), after.toString('base64')] as [string, string],
  );
}