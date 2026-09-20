import { basename } from 'node:path';

/**
 * Runtime-enforced discipline. These rules used to live only in the system
 * prompt where the model could ignore them; now the agent loop consults
 * this state and REJECTS calls that break the rules.
 */
export class Guards {
  /** Files the model has actually read this session (normalized). */
  private readFiles = new Set<string>();
  /** Consecutive failures per file - the 3-strike counter. */
  private strikes = new Map<string, number>();
  /** Files mutated and not yet covered by a REAL verification. */
  readonly unverified = new Set<string>();
  /** Every file changed during the current task (for self-review). */
  readonly changedThisTask = new Set<string>();
  /** Plan mode: the runtime blocks all mutating tools. */
  planMode = false;
  /** Research is a preferred capability, not a hard gate. */
  trendResearchDone = false;
  /** Visual tasks must be rendered/inspected before finish. */
  requiresVisualReview = false;
  visualReviewDone = false;
  /** Visual tool found heuristic quality issues that need a follow-up review. */
  visualDesignNeedsAttention = false;

  private norm(p: string): string {
    return p.replace(/\\/g, '/').replace(/^[.][/]/, '').toLowerCase();
  }

  noteRead(paths: string[]): void {
    for (const p of paths) if (p) this.readFiles.add(this.norm(p));
  }

  hasRead(path: string): boolean {
    return this.readFiles.has(this.norm(path));
  }

  noteMutation(path: string): void {
    if (!path) return;
    this.unverified.add(this.norm(path));
    this.changedThisTask.add(this.norm(path));
    this.readFiles.add(this.norm(path)); // it wrote it, so it knows it
  }

  /** Record a failed call touching a file. Returns the strike count. */
  noteFailure(path: string): number {
    const key = this.norm(path);
    const n = (this.strikes.get(key) ?? 0) + 1;
    this.strikes.set(key, n);
    return n;
  }

  clearStrikes(path: string): void {
    this.strikes.delete(this.norm(path));
  }

  /** Reset per-task state at the start of every task. */
  startTask(task = ''): void {
    this.changedThisTask.clear();
    this.trendResearchDone = false;
    this.visualReviewDone = false;
    this.visualDesignNeedsAttention = false;
    const t = task.toLowerCase();
    this.requiresVisualReview = /\b(website|web ?site|landing|ui|ux|design|redesign|dashboard|ecommerce|e-commerce|storefront|brand|branding|portfolio|mobile app|app design|frontend|front-end|html|css|visual|screenshot|responsive|animation|interaction|blender|photoshop|premiere|unity|cad|3d model|render|illustration|gui)\b/.test(t);
  }

  /** Model may override the cheap fallback classification after its first response. */
  setTaskClassification(kind: 'visual' | 'nonvisual'): void { this.requiresVisualReview = kind === 'visual'; }

  noteResearch(): void { this.trendResearchDone = true; }
  noteVisualReview(output = ''): void {
    this.visualReviewDone = true;
    this.visualDesignNeedsAttention = /DESIGN_REVIEW:\s*NEEDS_ATTENTION/i.test(output);
  }

  /**
   * A verification only counts if it plausibly exercised a changed file:
   * the command/paths mention a changed file's name, or it is a page test
   * while HTML/CSS/JS changed. `echo hi` no longer counts.
   */
  noteVerification(tool: string, target: string, okResult: boolean): void {
    if (!okResult) return;
    const t = target.toLowerCase();
    const cleared: string[] = [];
    for (const file of this.unverified) {
      const name = basename(file);
      const stem = name.replace(/[.][^.]+$/, '');
      const webFile = /[.](html?|css|js|mjs)$/.test(file);
      const hit =
        t.includes(name) || (stem.length > 2 && t.includes(stem)) ||
        (tool === 'test_page' && webFile) ||
        (tool === 'run_command' && /\b(test|build|tsc|lint|compile|pytest|vitest|jest)\b/.test(t));
      if (hit) cleared.push(file);
    }
    for (const f of cleared) {
      this.unverified.delete(f);
      this.clearStrikes(f);
    }
  }

  /**
   * Gate a tool call BEFORE execution. Returns an error message the loop
   * sends back to the model, or null when the call is allowed.
   */
  gate(tool: string, path: string, mutating: boolean, fileExists: boolean): string | null {
    if (this.planMode && (mutating || tool === 'run_command' || tool === 'git' || tool === 'shell')) {
      return 'BLOCKED: plan mode is active. You may only use read-only tools ' +
        '(read_file, read_files, list_dir, tree, search, symbols, web_fetch). ' +
        'Produce the numbered plan, then finish.';
    }
    if ((tool === 'edit_file' || tool === 'write_file') && fileExists && !this.hasRead(path)) {
      return `BLOCKED: you are editing ${path} but never read it this session. ` +
        'Call read_file on it first - editing unseen code causes broken edits.';
    }
    if (mutating && (this.strikes.get(this.norm(path)) ?? 0) >= 3) {
      this.clearStrikes(path);
      return `BLOCKED (3 failed attempts on ${path}): your diagnosis is likely wrong. ` +
        'Re-read the ENTIRE file and the exact error text, state a NEW hypothesis ' +
        'in one line, then try a DIFFERENT fix.';
    }
    return null;
  }
}