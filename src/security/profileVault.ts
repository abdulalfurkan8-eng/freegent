import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ROOT_DIR, PROFILE_DIR } from '../utils/paths.js';

const VAULT = join(ROOT_DIR, 'profile.vault');
const KEY_FILE = join(ROOT_DIR, 'profile.key');
const MAGIC = Buffer.from('DCP1');

async function key(): Promise<Buffer> {
  if (process.env.FREEGENT_PROFILE_KEY) return createHash('sha256').update(process.env.FREEGENT_PROFILE_KEY).digest();
  try { return Buffer.from((await readFile(KEY_FILE, 'utf8')).trim(), 'hex'); } catch { const k=randomBytes(32); await writeFile(KEY_FILE,k.toString('hex'),{mode:0o600}); await chmod(KEY_FILE,0o600).catch(()=>undefined); return k; }
}
async function files(dir:string):Promise<string[]> { const out:string[]=[]; for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name); if(e.isDirectory()) out.push(...await files(p)); else if(e.isFile()) out.push(p);} return out; }
function seal(data:Buffer,k:Buffer):Buffer { const iv=randomBytes(12); const c=createCipheriv('aes-256-gcm',k,iv); const body=Buffer.concat([c.update(data),c.final()]); return Buffer.concat([MAGIC,iv,c.getAuthTag(),body]); }
function open(data:Buffer,k:Buffer):Buffer { if(!data.subarray(0,4).equals(MAGIC)) throw new Error('Invalid FreeGent profile vault record'); const iv=data.subarray(4,16), tag=data.subarray(16,32), body=data.subarray(32); const d=createDecipheriv('aes-256-gcm',k,iv); d.setAuthTag(tag); return Buffer.concat([d.update(body),d.final()]); }
export async function unsealProfile():Promise<void>{ try{const manifest=JSON.parse(await readFile(join(VAULT,'manifest.json'),'utf8')) as string[]; const k=await key(); await mkdir(PROFILE_DIR,{recursive:true}); for(const rel of manifest){const src=join(VAULT,'files',rel+'.enc'); const dst=join(PROFILE_DIR,rel); await mkdir(join(dst,'..'),{recursive:true}); await writeFile(dst,open(await readFile(src),k));} }catch(e){ if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; } }
export async function sealProfile():Promise<void>{ const info=await stat(PROFILE_DIR).catch(()=>null); if(!info?.isDirectory()) return; const list=await files(PROFILE_DIR); if(!list.length) return; const k=await key(); await rm(VAULT,{recursive:true,force:true}); await mkdir(join(VAULT,'files'),{recursive:true}); const manifest:string[]=[]; for(const src of list){const rel=relative(PROFILE_DIR,src).replaceAll('\\','/'); manifest.push(rel); const dst=join(VAULT,'files',rel+'.enc'); await mkdir(join(dst,'..'),{recursive:true}); await writeFile(dst,seal(await readFile(src),k));} await writeFile(join(VAULT,'manifest.json'),JSON.stringify(manifest)); await rm(PROFILE_DIR,{recursive:true,force:true}); }
