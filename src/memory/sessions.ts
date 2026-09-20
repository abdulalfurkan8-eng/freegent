import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT_DIR, ensureRoot } from '../utils/paths.js';
import { DEFAULTS } from '../config/defaults.js';
const SESSIONS_FILE = join(ROOT_DIR, 'sessions.json');
const LOCK = `${SESSIONS_FILE}.lock`;
const MAX_SESSIONS = 50;
export interface ChatSession { id:string; name:string; url:string; cwd:string; createdAt:string; lastUsedAt:string; }
async function lock<T>(fn:()=>Promise<T>):Promise<T>{await ensureRoot();const t=Date.now();while(true){try{await mkdir(LOCK);break}catch{if(Date.now()-t>DEFAULTS.memory.lockTimeoutMs)throw new Error('Session store is locked');await new Promise(r=>setTimeout(r,DEFAULTS.memory.lockRetryMs));}}try{return await fn()}finally{await rm(LOCK,{recursive:true,force:true}).catch(()=>undefined)}}
export async function loadSessions():Promise<ChatSession[]>{try{return JSON.parse(await readFile(SESSIONS_FILE,'utf8')) as ChatSession[]}catch{return[]}}
async function saveAll(s:ChatSession[]):Promise<void>{await ensureRoot();await writeFile(SESSIONS_FILE,JSON.stringify(s.slice(0,MAX_SESSIONS),null,2),'utf8')}
export async function upsertSession(session:ChatSession):Promise<void>{await lock(async()=>{const all=await loadSessions();await saveAll([session,...all.filter(s=>s.id!==session.id&&s.url!==session.url)])})}
export async function renameSessionById(id:string,name:string):Promise<boolean>{return lock(async()=>{const all=await loadSessions();const t=all.find(s=>s.id===id);if(!t)return false;t.name=name;await saveAll(all);return true})}
export async function findSession(key:string):Promise<ChatSession|null>{const all=await loadSessions();const n=Number(key);if(Number.isInteger(n)&&n>=1&&n<=all.length)return all[n-1];const l=key.toLowerCase();return all.find(s=>s.name.toLowerCase().includes(l))??null}
