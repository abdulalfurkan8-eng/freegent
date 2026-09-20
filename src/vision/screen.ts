import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { powerShellCapture, powerShellCaptureAnnotated, powerShellFrameHash } from '../windows/powershell.js';
import { clearUiHandles, foregroundWindow, frameHashRect, captureWindow } from '../windows/computer.js';

let lastHash=''; let lastPath=''; let lastOcr:string[]=[]; let lastAt=0; let lastWidth=0; let lastHeight=0; let lastForeground='';
export interface ScreenObservation { path:string; hash:string; changed:boolean; ocr:string[]; width:number; height:number; changedRegion?:[number,number,number,number]; }
export async function screenHash():Promise<string>{ if(process.platform!=='win32')throw new Error('Screen capture currently requires Windows'); const h=await powerShellFrameHash(); if(lastHash&&h!==lastHash) await clearUiHandles().catch(()=>undefined); lastHash=h; lastAt=Date.now(); return h; }
export async function captureScreen(force=false):Promise<ScreenObservation>{
 if(process.platform!=='win32')throw new Error('Screen capture currently requires Windows');
 const previousHash=lastHash; const hash=await powerShellFrameHash(); const now=Date.now();
 if(!force && hash===previousHash && now-lastAt<10_000 && lastPath){ return {path:lastPath,hash,changed:false,ocr:lastOcr,width:lastWidth,height:lastHeight}; }
 const out=join(tmpdir(),`freegent-screen-${now}.png`); await powerShellCapture(out); await access(out);
 const actual=hash;
 const changed=actual!==previousHash; if(changed)lastOcr=await runOcr(out);
 lastHash=actual; lastPath=out; lastAt=now;
 const dims=await imageDimensions(out);
 lastWidth=dims[0]; lastHeight=dims[1];
 return {path:out,hash:actual,changed,ocr:lastOcr,width:lastWidth,height:lastHeight};
}
/**
 * Screenshot with a burned-in coordinate grid. Generalist chat models are
 * unreliable at reading raw pixel coordinates off a plain screenshot, which
 * is a large chunk of why "click and hope" fails against unfamiliar UIs.
 * Call this instead of captureScreen()/captureForegroundWindow() right
 * before a click when precision matters (small targets, unfamiliar apps).
 */
export async function captureAnnotatedScreen(spacing = 100): Promise<ScreenObservation> {
  if (process.platform !== 'win32') throw new Error('Screen capture currently requires Windows');
  const w = await foregroundWindow();
  const region = w ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const now = Date.now();
  const out = join(tmpdir(), `freegent-grid-${now}.png`);
  await powerShellCaptureAnnotated(out, region.x, region.y, region.width, region.height, spacing);
  await access(out);
  const hash = await frameHashRect(region.x, region.y, region.width, region.height);
  const ocr = await runOcr(out);
  return { path: out, hash, changed: true, ocr, width: region.width, height: region.height };
}

async function imageDimensions(path:string):Promise<[number,number]>{
 // PNG IHDR is fixed-format; avoid loading System.Drawing just to get dimensions.
 const b=await readFile(path); if(b.length<24)throw new Error('Invalid PNG'); return [b.readUInt32BE(16),b.readUInt32BE(20)];
}
async function runOcr(path:string):Promise<string[]>{try{const r=await execa('tesseract',[path,'stdout','--psm','11'],{reject:false,timeout:15_000});if(r.exitCode===0)return(r.stdout||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,300)}catch{}return[]}

export async function captureRegion(x:number,y:number,width:number,height:number,force=true):Promise<ScreenObservation>{
 if(process.platform!=='win32')throw new Error('Screen capture currently requires Windows');
 const previousHash=lastHash; const hash=await frameHashRect(x,y,width,height); const now=Date.now();
 if(!force&&hash===previousHash&&now-lastAt<10_000&&lastPath)return {path:lastPath,hash,changed:false,ocr:lastOcr,width:lastWidth,height:lastHeight};
 const out=join(tmpdir(),`freegent-region-${now}.png`);
 const { powershell } = await import('../windows/powershell.js'); await powershell(`[FreeGentWin32]::CaptureRect('${out.replace(/'/g,"''")}',${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)})`,30_000);
 await access(out); const changed=hash!==previousHash; if(changed){await clearUiHandles().catch(()=>undefined);lastOcr=await runOcr(out);} lastHash=hash;lastPath=out;lastAt=now;lastWidth=Math.round(width);lastHeight=Math.round(height); return {path:out,hash,changed,ocr:lastOcr,width:lastWidth,height:lastHeight};
}
export async function captureForegroundWindow(force=true):Promise<ScreenObservation>{
 const w=await foregroundWindow(); if(!w) return captureScreen(force); const previousHash=lastHash; const hash=await frameHashRect(w.x,w.y,w.width,w.height); const now=Date.now(); if(!force&&hash===previousHash&&now-lastAt<10_000&&lastPath)return {path:lastPath,hash,changed:false,ocr:lastOcr,width:lastWidth,height:lastHeight}; const out=join(tmpdir(),`freegent-window-${now}.png`); await captureWindow(out,w.handle); await access(out); const changed=hash!==previousHash; if(changed){await clearUiHandles().catch(()=>undefined);lastOcr=await runOcr(out);} lastHash=hash;lastPath=out;lastAt=now;lastWidth=w.width;lastHeight=w.height; return {path:out,hash,changed,ocr:lastOcr,width:w.width,height:w.height};
}
export function lastScreenPath():string{return lastPath;}
