/** Fallback selectors for the DeepSeek web UI. */
export const SELECTORS = {
  /** Chat input candidates, most specific first. Never matches the reCAPTCHA textarea. */
  composer: [
    'textarea#chat-input',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="DeepSeek"]',
    '[contenteditable="true"]',
    'textarea:not([name="g-recaptcha-response"]):not([id*="recaptcha"])',
  ],
  deepThink: [
    'button:has-text("DeepThink")',
    '[class*="deepthink"]',
    'button[aria-label*="DeepThink"]',
  ],
  search: [
    'button:has-text("Search")',
    '[class*="search-btn"]',
    'button[aria-label*="Search"]',
  ],
    sendButton: [
    'button[type="submit"]',
    'button:has(svg)',
    'button[aria-label*="Send"]',
  ],
  assistantMessage: [
    '[data-role="assistant"]',
    '[data-message-author-role="assistant"]',
    '[data-testid*="assistant"]',
    '[data-testid*="message-content"]',
    '[class*="assistant-message"]',
    '[class*="message-content"]',
    '[class*="prose"]',
    '.markdown',
    'article',
    '[data-testid*="message"]',
  ],
  stopButton: [
    'button:has-text("Stop")',
    'button[aria-label*="Stop"]',
  ],
  newChat: [
    'button:has-text("New Chat")',
    'a:has-text("New Chat")',
  ],
};

export function selectorList(values: string[]): string {
  return values.join(', ');
}
/** Discover UI candidates from semantics when static selectors stop matching. */
export async function discoverSelector(page: import('playwright').Page, kind: keyof typeof SELECTORS): Promise<string | null> {
  const candidates = SELECTORS[kind];
  for (const selector of candidates) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return selector;
  }
  const semantic = kind === 'composer'
    ? ['textarea', '[contenteditable="true"]']
    : kind === 'sendButton'
      ? ['button', '[role="button"]'] : ['button', '[role="button"]', 'a'];
  for (const selector of semantic) {
    const loc = page.locator(selector);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = `${await el.getAttribute('aria-label').catch(() => '')} ${await el.getAttribute('placeholder').catch(() => '')} ${await el.innerText().catch(() => '')}`.toLowerCase();
      const wanted = kind === 'composer' ? /message|chat|ask|prompt/.test(text) : kind === 'sendButton' ? /send|submit/.test(text) : true;
      if (wanted) return selector;
    }
  }
  return null;
}
