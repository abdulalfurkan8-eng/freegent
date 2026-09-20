import { launchApplication, focusWindow, keyboard, uiAction, findUiElement } from '../windows/computer.js';

export interface FastResult { handled: boolean; output?: string; }
const APP_ALIASES: Record<string,string> = {
  'vs code':'code',
  'visual studio code':'code',
  'notepad':'notepad.exe',
  'calculator':'calc.exe',
  'calc':'calc.exe',
  'paint':'mspaint.exe',
  'blender':'blender.exe',
};
function knownApp(raw:string): string | null {
  const key = raw.trim().replace(/[.!?]+$/,'').toLowerCase();
  return APP_ALIASES[key] ?? null;
}
function textAfter(s:string):string { return s.trim().replace(/^['"]|['"]$/g,''); }

export type FastComputerMatch =
  | { kind: 'open-and-type'; app: string; appLabel: string; text: string }
  | { kind: 'open'; app: string }
  | { kind: 'type'; text: string }
  | { kind: 'press'; key: string };

/** Only classify deterministic, unambiguous fast-lane commands. */
export function matchFastComputerTask(task:string): FastComputerMatch | null {
  const t=task.trim();
  let m=/^(?:please\s+)?open\s+(.+?)\s+and\s+(?:type|enter)\s*[:=-]\s*(.+)$/i.exec(t);
  if(m){
    const app=knownApp(m[1]);
    if(app) return {kind:'open-and-type', app, appLabel:m[1].trim(), text:textAfter(m[2])};
    return null;
  }
  m=/^(?:please\s+)?open\s+(.+?)\s*[.!?]?$/i.exec(t);
  if(m){
    const app=knownApp(m[1]);
    if(app) return {kind:'open', app};
    return null;
  }
  m=/^(?:please\s+)?type\s*[:=-]\s*(.+)$/i.exec(t);
  if(m) return {kind:'type', text:textAfter(m[1])};
  m=/^(?:please\s+)?press\s+(.+)$/i.exec(t);
  if(m) return {kind:'press', key:m[1].trim()};
  return null;
}

export async function tryFastComputerTask(task:string):Promise<FastResult>{
  if(process.platform!=='win32') return {handled:false};
  const match=matchFastComputerTask(task);
  if(!match) return {handled:false};

  if(match.kind==='open-and-type'){
    await launchApplication(match.app);
    await new Promise(r=>setTimeout(r,80));
    await focusWindow(match.appLabel);
    try {
      const el=await findUiElement({type:'Edit'});
      if(el){
        await uiAction('setValue',{type:'Edit',index:0},match.text);
        return {handled:true};
      }
    } catch {}
    await keyboard('type',match.text);
    return {handled:true};
  }

  if(match.kind==='open'){
    await launchApplication(match.app);
    // Opening an app is itself the result. Keep the fast lane silent.
    return {handled:true};
  }

  if(match.kind==='type'){
    await keyboard('type',match.text);
    return {handled:true};
  }

  await keyboard('key',match.key);
  return {handled:true};
}
