import { ToolCall, ToolContext, ToolResult, ok, fail } from './types.js';

const MAX_CHARS = 12_000;

// Sites 403/block the old "freegent-agent" UA - a real browser UA fixes most.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Successful fetches this session, per unique URL. The research breadth
 * check reads this instead of grepping the model's prose - the model
 * describing its sources is not evidence that it fetched them.
 */
const fetchedUrls = new Set<string>();
export function fetchedSourceCount(): number { return fetchedUrls.size; }
export function resetFetchedSources(): void { fetchedUrls.clear(); }

/** Fetch a web page and return readable text (for docs lookups etc.). */
export async function webFetchTool(
  call: ToolCall,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const url = String(call.url ?? '');
  if (!/^https?:\/\//i.test(url)) {
    return fail('web_fetch: "url" must start with http:// or https://');
  }
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    // A blocked/missing page must READ as a failure, or the model counts it
    // as a fetched source and research breadth silently collapses.
    if (res.status >= 400) {
      return fail(
        `web_fetch: ${url} returned HTTP ${res.status}. ` +
          'Source NOT fetched - do not cite it. Try a different site.',
      );
    }
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) {
      return fail(
        `web_fetch: ${url} had no readable text (likely JS-only page). ` +
          'Source NOT fetched - try a different site.',
      );
    }
    fetchedUrls.add(url.replace(/[#].*$/, ''));
    const body =
      text.length > MAX_CHARS
        ? `${text.slice(0, MAX_CHARS)} ...[truncated ${text.length - MAX_CHARS} chars]`
        : text;
    return ok(`status ${res.status} ${url}\n${body}`);
  } catch (err) {
    return fail(`web_fetch failed: ${(err as Error).message}`);
  }
}