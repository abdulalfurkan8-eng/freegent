import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets } from '../security/secrets.js';
export interface StrategyOutcome { strategy:string; taskClass:string; success:boolean; attempts:number; durationMs?:number; note?:string; ts:string; }
const outcomes: StrategyOutcome[]=[];
function file():string{return join(process.cwd(),'.freegent','strategies.jsonl');}
async function loadPersisted():Promise<void>{if(outcomes.length)return;const raw=await readFile(file(),'utf8').catch(()=> '');for(const line of raw.split(/\r?\n/).filter(Boolean)){try{outcomes.push(JSON.parse(line) as StrategyOutcome)}catch{/* skip corrupt record */}}}
export async function recordStrategyOutcome(x:Omit<StrategyOutcome,'ts'>):Promise<void>{await loadPersisted();const v={...x,ts:new Date().toISOString()};outcomes.push(v);if(outcomes.length>500)outcomes.shift();await mkdir(join(process.cwd(),'.freegent'),{recursive:true});await appendFile(file(),JSON.stringify({...v,note:v.note?redactSecrets(v.note):v.note})+'\n','utf8').catch(()=>undefined);}
export async function learnedStrategy(taskClass:string):Promise<string[]>{await loadPersisted();return outcomes.filter(x=>x.taskClass===taskClass&&x.success).sort((a,b)=>a.attempts-b.attempts).slice(0,5).map(x=>x.strategy);}
