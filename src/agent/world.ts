import { z } from 'zod';
const WorldPatch = z.object({
  activeApplication: z.string().optional(), activeWindow: z.string().optional(), project: z.string().optional(), workspace: z.string().optional(),
  selection: z.string().optional(), unsavedChanges: z.boolean().optional(), dialog: z.string().optional(), taskProgress: z.string().optional(),
  lastAction: z.string().optional(), expectedResult: z.string().optional(), observedResult: z.string().optional(), confidence: z.number().min(0).max(1).optional(),
}).strict();
export interface WorldState { activeApplication?: string; activeWindow?: string; project?: string; workspace?: string; selection?: string; unsavedChanges?: boolean; dialog?: string; taskProgress?: string; lastAction?: string; expectedResult?: string; observedResult?: string; confidence: number; updatedAt: string; }
export class WorldModel {
  private state: WorldState = { confidence: 0, updatedAt: new Date().toISOString() };
  update(patch: Partial<WorldState>): WorldState {
    const safe = WorldPatch.parse(patch);
    this.state = { ...this.state, ...safe, updatedAt: new Date().toISOString() };
    return this.snapshot();
  }
  snapshot(): WorldState { return { ...this.state }; }
  context(): string { return JSON.stringify(this.state); }
}
