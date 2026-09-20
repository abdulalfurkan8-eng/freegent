import { checkpointFile, rewind } from '../memory/checkpoints.js';
export { checkpointFile, rewind };
export interface CheckpointScope { id:string; files:string[]; createdAt:string; }
export function checkpointScope(files:string[]): CheckpointScope { return { id:`cp-${Date.now().toString(36)}`, files:[...files], createdAt:new Date().toISOString() }; }
