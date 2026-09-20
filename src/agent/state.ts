import { WorldModel } from './world.js';
/** Structured runtime state shared by the agent loop and future perception layers.
 *
 * Phase 1 deliberately keeps this as an in-memory projection: it does not
 * replace the existing session/memory stores. The goal is to give later
 * Windows/vision work one stable state contract without forcing a rewrite.
 */
export interface DetectedElement {
  type: string;
  name?: string;
  bbox?: [number, number, number, number];
  center?: [number, number];
  confidence?: number;
  source: string;
  timestamp: number;
}

export interface AgentTaskState {
  goal: string;
  step: number;
  status: 'idle' | 'running' | 'verifying' | 'paused' | 'completed' | 'failed';
}

export interface AgentActionState {
  tool: string;
  arguments: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
}

export interface VerificationState {
  tool?: string;
  target?: string;
  ok: boolean;
  timestamp?: string;
}

export interface AgentStateSnapshot {
  activeApplication?: string;
  activeWindow?: string;
  screen?: { width: number; height: number; changed?: boolean; hash?: string; screenshotPath?: string };
  detectedElements: DetectedElement[];
  ocr: string[];
  uiTree: Record<string, unknown>;
  task: AgentTaskState;
  memoryContext: string[];
  lastAction?: AgentActionState;
  verification: VerificationState;
}

export class AgentState {
  readonly world = new WorldModel();
  private state: AgentStateSnapshot;
  private contextCache = '';
  private dirty = true;

  constructor(goal = '') {
    this.state = {
      detectedElements: [],
      ocr: [],
      uiTree: {},
      task: { goal, step: 0, status: goal ? 'running' : 'idle' },
      memoryContext: [],
      verification: { ok: false },
    };
  }

  resetTask(goal: string): void {
    this.state.task = { goal, step: 0, status: 'running' };
    this.dirty = true;
    this.state.lastAction = undefined;
    this.state.verification = { ok: false };
  }

  beginAction(tool: string, args: Record<string, unknown>): void {
    this.dirty = true;
    this.state.lastAction = {
      tool,
      arguments: { ...args },
      startedAt: new Date().toISOString(),
    };
    this.state.task.step += 1;
  }

  endAction(ok: boolean): void {
    if (!this.state.lastAction) return;
    this.dirty = true;
    this.state.lastAction.finishedAt = new Date().toISOString();
    this.state.lastAction.ok = ok;
    this.state.verification = { ok: false };
  }

  noteVerification(tool: string, target: string, ok: boolean): void {
    this.dirty = true;
    this.state.verification = { tool, target, ok, timestamp: new Date().toISOString() };
    this.state.task.status = ok ? 'verifying' : 'running';
  }

  complete(): void { this.state.task.status = 'completed'; this.dirty = true; }
  pause(): void { this.state.task.status = 'paused'; this.dirty = true; }
  fail(): void { this.state.task.status = 'failed'; this.dirty = true; }

  setScreen(width: number, height: number, changed = true, hash?: string, screenshotPath?: string): void {
    this.dirty = true;
    this.state.screen = { width, height, changed, hash, screenshotPath };
  }

  setApplication(application?: string, window?: string): void {
    this.dirty = true;
    this.state.activeApplication = application;
    this.state.activeWindow = window;
  }

  setPerception(input: {
    detectedElements?: DetectedElement[];
    ocr?: string[];
    uiTree?: Record<string, unknown>;
  }): void {
    this.dirty = true;
    if (input.detectedElements) this.state.detectedElements = [...input.detectedElements];
    if (input.ocr) this.state.ocr = [...input.ocr];
    if (input.uiTree) this.state.uiTree = { ...input.uiTree };
  }

  setMemoryContext(entries: string[]): void {
    this.state.memoryContext = [...entries];
  }

  snapshot(): AgentStateSnapshot {
    return structuredClone(this.state);
  }

  /** Compact projection safe to inject into the model on the next turn. */
  contextForModel(maxElements = 40): string {
    const s = this.state;
    const elements = s.detectedElements.slice(-maxElements).map((e) => ({
      type: e.type, name: e.name, bbox: e.bbox, center: e.center,
      confidence: e.confidence, source: e.source, screenHash: s.screen?.hash,
    }));
    if (!this.dirty && this.contextCache) return this.contextCache;
    this.contextCache = JSON.stringify({ world: this.world.snapshot(), task: s.task, activeApplication: s.activeApplication,
      activeWindow: s.activeWindow, screen: s.screen, ocr: s.ocr.slice(-80), detectedElements: elements,
      lastAction: s.lastAction, verification: s.verification, memoryContext: s.memoryContext.slice(-20) });
    this.dirty = false;
    return this.contextCache;
  }
}
