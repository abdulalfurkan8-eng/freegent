import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, stat, rename } from 'node:fs/promises';
import { DEFAULTS } from '../config/defaults.js';
import { redactSecrets } from '../security/secrets.js';
import { join } from 'node:path';
import { WorldModel } from './world.js';
import { recoveryPlan } from './recovery.js';

export type RuntimePhase = 'understand'|'investigate'|'plan'|'observe'|'decide'|'act'|'verify'|'recover'|'complete'|'failed';
export type RiskLevel = 'low'|'medium'|'high';

export interface ActionContract {
  intent: string;
  tool: string;
  preconditions?: string[];
  expectedChange?: string;
  postconditions?: string[];
  verification?: string;
  fallback?: string;
  risk: RiskLevel;
}

export interface RuntimeEvent {
  ts: string;
  phase: RuntimePhase;
  kind: 'task'|'action'|'result'|'observation'|'verification'|'recovery'|'decision';
  message: string;
  data?: Record<string, unknown>;
}

export class AgentRuntime {
  private phase: RuntimePhase = 'understand';
  private failures = 0;
  private sameFailure = 0;
  private lastFailure = '';
  private actionSeq = 0;
  private journalEntryCount = 0;
  private events: RuntimeEvent[] = [];
  private readonly journalPath: string;
  readonly world = new WorldModel();

  constructor(private readonly cwd: string) {
    this.journalPath = join(cwd, '.freegent', 'runtime.jsonl');
  }

  async start(goal: string): Promise<void> {
    this.phase = 'understand';
    this.failures = 0; this.sameFailure = 0; this.lastFailure = ''; this.actionSeq = 0;
    this.events = [];
    this.journalEntryCount = ((await readFile(this.journalPath, 'utf8').catch(() => '')).match(/\n/g) ?? []).length;
    await this.record('task', `Started: ${goal}`, { goal });
  }

  get currentPhase(): RuntimePhase { return this.phase; }
  get failureCount(): number { return this.failures; }

  async transition(phase: RuntimePhase, message: string, data?: Record<string, unknown>): Promise<void> {
    this.phase = phase;
    await this.record('decision', message, data);
  }

  async beginAction(contract: ActionContract): Promise<number> {
    this.actionSeq += 1;
    await this.transition('act', `Action ${this.actionSeq}: ${contract.intent}`, {
      tool: contract.tool, risk: contract.risk, expectedChange: contract.expectedChange,
      verification: contract.verification,
    });
    return this.actionSeq;
  }

  async result(ok: boolean, output: string, signature: string): Promise<void> {
    const normalized = createHash('sha1').update(signature).digest('hex').slice(0, 12);
    if (ok) {
      this.sameFailure = 0; this.lastFailure = '';
      await this.record('result', 'Action succeeded', { output: output.slice(0, 1200) });
      return;
    }
    this.failures++;
    this.sameFailure = normalized === this.lastFailure ? this.sameFailure + 1 : 1;
    this.lastFailure = normalized;
    await this.record('result', 'Action failed', { signature: normalized, sameFailure: this.sameFailure, output: output.slice(0, 1200) });
  }

  async observe(message: string, data?: Record<string, unknown>): Promise<void> {
    await this.transition('observe', message, data);
  }

  async verify(ok: boolean, message: string): Promise<void> {
    await this.transition('verify', ok ? `Verified: ${message}` : `Verification failed: ${message}`, { ok });
  }

  async recover(reason: string, strategy: string): Promise<void> {
    await this.transition('recover', `Recovery: ${reason}`, { strategy, failures: this.failures, sameFailure: this.sameFailure });
  }

  shouldChangeStrategy(): boolean { return this.sameFailure >= 2 || this.failures >= 3; }

  recoverySteps(): string[] { return recoveryPlan(this.failures, this.sameFailure); }

  recoveryGuidance(): string {
    if (this.sameFailure >= 2) return 'Do not repeat the failed call. Re-observe, diagnose the new state, and use a materially different strategy.';
    if (this.failures >= 3) return 'Failure budget is exhausted for the current approach. Replan from evidence before another mutation.';
    return 'Continue normally, but verify the expected postcondition.';
  }

  async complete(summary: string): Promise<void> { await this.transition('complete', summary); }
  async fail(reason: string): Promise<void> { await this.transition('failed', reason); }

  context(): string {
    return JSON.stringify({ phase: this.phase, failures: this.failures, sameFailure: this.sameFailure, recoveryGuidance: this.recoveryGuidance(), recoverySteps: this.recoverySteps(), world: this.world.snapshot(), recent: this.events.slice(-8).map(e => ({ phase:e.phase, kind:e.kind, message:e.message })) });
  }

  private async record(kind: RuntimeEvent['kind'], message: string, data?: Record<string, unknown>): Promise<void> {
    const event: RuntimeEvent = { ts: new Date().toISOString(), phase: this.phase, kind, message, data };
    this.events.push(event);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    try {
      await mkdir(join(this.cwd, '.freegent'), { recursive: true });
      const info = await stat(this.journalPath).catch(() => null);
      if (info && (info.size >= DEFAULTS.agent.runtimeMaxBytes || this.journalEntryCount >= DEFAULTS.agent.runtimeMaxEntries)) await rename(this.journalPath, `${this.journalPath}.${Date.now()}.log`).catch(() => undefined);
      if (info && (info.size >= DEFAULTS.agent.runtimeMaxBytes || this.journalEntryCount >= DEFAULTS.agent.runtimeMaxEntries)) this.journalEntryCount = 0;
      await appendFile(this.journalPath, JSON.stringify({ ...event, message: redactSecrets(event.message), data: event.data ? Object.fromEntries(Object.entries(event.data).map(([k,v]) => [k, typeof v === 'string' ? redactSecrets(v) : v])) : undefined }) + '\n', 'utf8');
      this.journalEntryCount++;
    } catch { /* runtime telemetry must never break the task */ }
  }
}

export async function readRecentRuntime(cwd: string, max = 30): Promise<string> {
  try {
    const text = await readFile(join(cwd, '.freegent', 'runtime.jsonl'), 'utf8');
    return text.trim().split('\n').slice(-max).join('\n');
  } catch { return ''; }
}
