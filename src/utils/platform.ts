import { access } from 'node:fs/promises';
import { execa } from 'execa';

/** True when running inside Android Termux. */
export function isTermux(): boolean {
  return (
    process.platform === 'android' ||
    process.env.FREEGENT_ANDROID === '1' ||
    Boolean(process.env.TERMUX_VERSION) ||
    (process.env.PREFIX ?? '').includes('com.termux')
  );
}

/**
 * Locate the Termux-installed chromium binary (pkg install chromium).
 * Playwright's bundled Chromium does not run on Android - the system
 * package is the only way.
 */
export async function findTermuxChromium(): Promise<string | null> {
  for (const name of ['chromium-browser', 'chromium', 'chrome']) {
    const r = await execa('which', [name], { reject: false });
    if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  // Common absolute location as a fallback.
  const candidate = `${process.env.PREFIX ?? ''}/bin/chromium-browser`;
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export const TERMUX_SETUP_HELP = [
  'FreeGent on Termux needs the system chromium. IN THIS ORDER:',
  '  pkg install x11-repo     (adds the repo with chromium deps)',
  '  pkg update               (refresh lists WITH the new repo)',
  '  pkg install chromium     (deps now resolve)',
  'Then run "freegent login" again.',
  'Tip: install freegent with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install',
].join('\n');