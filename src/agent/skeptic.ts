import { cwd } from 'node:process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserSession } from '../browser/session.js';
import { ensureLoggedIn, sendPrompt, waitForCompleteResponse, snapshotAssistant, startNewChat } from '../browser/deepseek.js';
import { logger } from '../utils/logger.js';

export interface SkepticFinding {
  severity: 'error' | 'warning';
  file: string;
  description: string;
  suggestion: string;
}

/**
 * Run a skeptic review on changed files. Spawn a read-only agent that tries
 * to find flaws, security issues, or missing logic. Returns findings that
 * should block the finish (errors) or warn (warnings).
 */
export async function runSkepticReview(
  changedFiles: Set<string>,
  browser: BrowserSession,
): Promise<SkepticFinding[]> {
  if (changedFiles.size === 0) return [];

  // Read all changed files and include their content for the skeptic.
  // Previously only sent filename + line count — DeepSeek had no code to review.
  const fileSummaries: string[] = [];
  for (const file of Array.from(changedFiles).slice(0, 5)) {
    try {
      const abs = resolve(cwd(), file);
      const content = await readFile(abs, 'utf8');
      const lines = content.split('\n');
      // Cap per-file to 300 lines so the total prompt stays reasonable.
      const body = lines.slice(0, 300).join('\n');
      const truncNote = lines.length > 300 ? `\n... (truncated, ${lines.length} lines total)` : '';
      fileSummaries.push(`\n### ${file} (${lines.length} lines)\n\`\`\`\n${body}${truncNote}\n\`\`\``);
    } catch {
      fileSummaries.push(`${file} (unreadable)`);
    }
  }

  const page = browser.page;
  const prevUrl = page.url();

  try {
    // Start a side session for the skeptic review
    await startNewChat(page, 'https://chat.deepseek.com');
    await ensureLoggedIn(page);

    const task = `You are a code skeptic. The AI just finished these changes:
${fileSummaries.join('\n')}

Your job: Find 3-5 potential issues with this code. Look for:
1. Logic errors or off-by-one bugs
2. Missing error handling
3. Security issues (injection, XSS, SQL injection)
4. Performance problems (N+1, memory leaks)
5. Missing edge cases
6. Inconsistent style or broken imports

Be STRICT. If you find real issues, list them. If the code looks clean, say "APPROVED".
Format: one issue per line, "FILE:LINE severity: issue description"`;

    let snapshot = await snapshotAssistant(page);
    await sendPrompt(page, task);

    const reply = await waitForCompleteResponse(page, 3000, 30_000, snapshot);
    const findings = parseSkepticReply(reply);
    logger.info(`Skeptic found ${findings.length} issues`);
    return findings;
  } catch (err) {
    logger.warn(`Skeptic review failed: ${(err as Error).message}`);
    return [];
  } finally {
    // Return to the original chat (don't save this session)
    await page.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch((err) => logger.warn(`Skeptic restore navigation failed: ${(err as Error).message}`));
  }
}

function parseSkepticReply(reply: string): SkepticFinding[] {
  const findings: SkepticFinding[] = [];
  if (reply.includes('APPROVED') || reply.includes('looks clean')) return findings;

  for (const line of reply.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 10) continue;

    // Try to parse "FILE:LINE severity: issue"
    const m = trimmed.match(/^([^\s:]+):(\d+)?\s+(error|warning):\s*(.+)$/i);
    if (m) {
      findings.push({
        severity: (m[3].toLowerCase() as 'error' | 'warning') || 'warning',
        file: m[1],
        description: m[4],
        suggestion: `Review ${m[1]} line ${m[2] || '?'}: ${m[4]}`,
      });
    }
  }
  return findings;
}