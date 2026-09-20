import type { Page } from 'playwright';

/**
 * A numbered map of everything interactive on the page.
 *
 * The model is bad at inventing CSS selectors for pages with obfuscated or
 * ad-generated class names - it guesses "#continue" and misses. So instead we
 * tag each visible interactive element with data-dc-i and hand the model a
 * plain list. It then clicks BY INDEX, which cannot be mistyped.
 */

export interface MappedEl {
  i: number;
  tag: string;
  kind: string;
  text: string;
}

/** Tag interactive elements in the page and return them as a list. */
export async function pageMap(page: Page): Promise<MappedEl[]> {
  return page.evaluate(() => {
    const SEL = 'a,button,input,select,textarea,summary,' +
      '[role=button],[role=link],[role=tab],[onclick],[tabindex]';
    const out: MappedEl[] = [];
    let i = 0;
    document.querySelectorAll('[data-dc-i]').forEach((e) => {
      e.removeAttribute('data-dc-i');
    });
    for (const el of Array.from(document.querySelectorAll(SEL))) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      if (Number(st.opacity) < 0.05) continue;
      const he = el as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const kind = tag === 'input'
        ? `input[${(el as HTMLInputElement).type || 'text'}]`
        : tag;
      const label = (
        he.innerText ||
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('value') ||
        el.getAttribute('title') ||
        ''
      ).replace(/\s+/g, ' ').trim().slice(0, 70);
      const dis = (el as HTMLButtonElement).disabled ? ' (disabled)' : '';
      el.setAttribute('data-dc-i', String(i));
      out.push({ i, tag, kind, text: label + dis });
      i++;
      if (i >= 120) break;
    }
    return out;
  });
}

/** Render the map as compact lines for the model to read. */
export function renderMap(els: MappedEl[]): string {
  if (els.length === 0) return 'No interactive elements found on the page.';
  return els
    .map((e) => `[${e.i}] ${e.kind} "${e.text || '(no label)'}"`)
    .join('\n');
}

/** Selector for an index from the last pageMap call. */
export function indexSelector(i: number): string {
  return `[data-dc-i="${i}"]`;
}