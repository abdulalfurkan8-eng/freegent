import { powershell, powerShellCapture } from './powershell.js';

export interface PointElement { name?:string; type?:string; automationId?:string; className?:string; x?:number; y?:number; width?:number; height?:number; enabled?:boolean; }

/**
 * What UIA actually reports sitting under a screen point right now — the
 * ground truth used to verify a click landed where it was meant to.
 *
 * Deliberately a plain PowerShell script (like findUiElement/uiTree below),
 * NOT a compiled FreeGentWin32 method: WPF types (System.Windows.Point,
 * AutomationElement) resolve fine dynamically inside a .ps1 script once
 * UIAutomationClient/UIAutomationTypes are loaded, but referencing them from
 * *compiled* C# via Add-Type -ReferencedAssemblies needs the exact right
 * assembly on that list or the whole FreeGentWin32 compile fails — which is
 * exactly what happened the first time this was added as a C# method.
 */
export async function elementAtPoint(x: number, y: number): Promise<PointElement | null> {
  const script = `try{$pt=New-Object System.Windows.Point -ArgumentList ${Math.round(x)},${Math.round(y)};$e=[System.Windows.Automation.AutomationElement]::FromPoint($pt);if($null-eq$e){'{}';exit};$r=$e.Current;$b=$r.BoundingRectangle;[pscustomobject]@{name=$r.Name;type=$r.ControlType.ProgrammaticName;automationId=$r.AutomationId;className=$r.ClassName;x=[int]$b.X;y=[int]$b.Y;width=[int]$b.Width;height=[int]$b.Height;enabled=$r.IsEnabled}|ConvertTo-Json -Compress}catch{'{}'}`;
  try {
    const out = await powershell(script, 10_000);
    const parsed = JSON.parse(out.trim().split(/\r?\n/).pop() || '{}');
    return Object.keys(parsed).length ? parsed : null;
  } catch { return null; }
}

export interface WindowInfo { handle: string; title: string; process: string; pid: number; x: number; y: number; width: number; height: number; visible: boolean; }
export interface UiElement { handle?: string; type: string; name: string; automationId?: string; className?: string; x:number;y:number;width:number;height:number;enabled:boolean;offscreen:boolean;patterns:string[];value?:string;depth?:number; }
const esc = (s: string): string => s.replace(/'/g, "''");

// ControlType members are interpolated into executable PowerShell, so this
// must be an allowlist rather than string escaping.  UIA's ProgrammaticName
// values use these member names (for example, "ControlType.Button").
export const UIA_CONTROL_TYPES = new Set([
  'AppBar', 'Button', 'Calendar', 'CheckBox', 'ComboBox', 'Custom', 'DataGrid',
  'DataItem', 'Document', 'Edit', 'Group', 'Header', 'HeaderItem', 'Hyperlink',
  'Image', 'List', 'ListItem', 'Menu', 'MenuBar', 'MenuItem', 'Pane',
  'ProgressBar', 'RadioButton', 'ScrollBar', 'SemanticZoom', 'Separator',
  'Slider', 'Spinner', 'SplitButton', 'StatusBar', 'Tab', 'TabItem', 'Table',
  'Text', 'Thumb', 'TitleBar', 'ToolBar', 'ToolTip', 'Tree', 'TreeItem',
  'Window',
] as const);

export function validateUiControlType(type: string): string {
  const value = type.trim();
  if (!(UIA_CONTROL_TYPES as ReadonlySet<string>).has(value)) {
    throw new Error(`Unsupported UIA control type: ${value || '(empty)'}`);
  }
  return value;
}

let lastForegroundHandle = '';

export async function listWindows(): Promise<WindowInfo[]> {
  const out = await powershell(`Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { $p=$_; $r=$p.MainWindowHandle; $rect=New-Object Object; $type=[type]::GetType('System.Drawing.Rectangle'); $b=[System.Windows.Forms.Screen]::AllScreens | Out-Null; $x=0;$y=0;$w=0;$h=0; try { $ui=[System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle); $bb=$ui.Current.BoundingRectangle; $x=[int]$bb.X;$y=[int]$bb.Y;$w=[int]$bb.Width;$h=[int]$bb.Height } catch {}; [pscustomobject]@{handle=('0x{0:X}' -f $p.MainWindowHandle);title=$p.MainWindowTitle;process=$p.ProcessName;pid=$p.Id;x=$x;y=$y;width=$w;height=$h;visible=[FreeGentWin32]::IsWindowVisible([IntPtr]$p.MainWindowHandle)} | ConvertTo-Json -Compress }`);
  return out.split(/\r?\n/).map(l=>{try{return JSON.parse(l) as WindowInfo}catch{return null}}).filter(Boolean) as WindowInfo[];
}
export async function foregroundWindow(): Promise<WindowInfo|null> {
  const h=await powershell(`('0x{0:X}' -f [FreeGentWin32]::GetForegroundWindow())`); return (await listWindows()).find(w=>w.handle.toLowerCase()===h.trim().toLowerCase())??null;
}
export async function launchApplication(app:string):Promise<string>{const v=esc(app.trim());if(!v)throw new Error('Application is required.');return powershell(`$v='${v}'; $existing=Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -ieq $v -or $_.MainWindowTitle -ieq $v) } | Select-Object -First 1; if($existing){[FreeGentWin32]::ShowWindow($existing.MainWindowHandle,9)|Out-Null;[FreeGentWin32]::SetForegroundWindow($existing.MainWindowHandle)|Out-Null;@{reused=$true;pid=$existing.Id;process=$existing.ProcessName}|ConvertTo-Json -Compress;return}; $cmd=Get-Command $v -ErrorAction SilentlyContinue;if($cmd){$p=Start-Process -FilePath $cmd.Source -PassThru;@{pid=$p.Id;process=$p.ProcessName}|ConvertTo-Json -Compress;return};if($v -match '^(https?|shell|ms-settings):'){Start-Process $v;return 'opened-uri'};if(Test-Path -LiteralPath $v){$p=Start-Process -FilePath $v -PassThru;@{pid=$p.Id;process=$p.ProcessName}|ConvertTo-Json -Compress;return};$p=Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',$v -PassThru -WindowStyle Hidden;@{pid=$p.Id;process=$p.ProcessName;mode='command'}|ConvertTo-Json -Compress`);}
export async function focusWindow(query:string):Promise<string>{const q=esc(query.trim());if(!q)throw new Error('Window query is required.');return powershell(`$q='${q}';$p=Get-Process|Where-Object{$_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$q*" -or $_.ProcessName -like "*$q*")}|Sort-Object @{Expression={$_.MainWindowTitle -ieq $q};Descending=$true},MainWindowTitle|Select-Object -First 1;if(-not $p){throw 'Window not found'};[FreeGentWin32]::ShowWindow($p.MainWindowHandle,9)|Out-Null;[FreeGentWin32]::SetForegroundWindow($p.MainWindowHandle)|Out-Null;$p.MainWindowTitle`);}

export interface WindowsState { foreground: WindowInfo|null; focused?: { name:string; automationId:string; className:string; type:string; x:number;y:number;width:number;height:number;enabled:boolean }|null; windows: WindowInfo[]; cursor:{x:number;y:number}; dpi:number; virtualScreen:{x:number;y:number;width:number;height:number}; }
export async function windowsState(): Promise<WindowsState> {
  const script = `$fw=[FreeGentWin32]::GetForegroundWindow();$focused=$null;try{$e=[System.Windows.Automation.AutomationElement]::FocusedElement();$r=$e.Current;$b=$r.BoundingRectangle;$fh=Set-FreeGentHandle $e;$fv='';try{$fv=($e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value}catch{};$focused=[pscustomobject]@{handle=$fh;name=$r.Name;automationId=$r.AutomationId;className=$r.ClassName;type=$r.ControlType.ProgrammaticName;x=[int]$b.X;y=[int]$b.Y;width=[int]$b.Width;height=[int]$b.Height;enabled=$r.IsEnabled;value=$fv}}catch{};$pt=New-Object FreeGentWin32+POINT;[FreeGentWin32]::GetCursorPos([ref]$pt)|Out-Null;$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen;$dpi=try{[FreeGentWin32]::GetDpiForWindow($fw)}catch{96};$win=Get-Process|Where-Object{$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle}|ForEach-Object{$p=$_;try{$u=[System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle);$b=$u.Current.BoundingRectangle;[pscustomobject]@{handle=('0x{0:X}' -f $p.MainWindowHandle);title=$p.MainWindowTitle;process=$p.ProcessName;pid=$p.Id;x=[int]$b.X;y=[int]$b.Y;width=[int]$b.Width;height=[int]$b.Height;visible=[FreeGentWin32]::IsWindowVisible([IntPtr]$p.MainWindowHandle)}}catch{}};[pscustomobject]@{foreground=($win|Where-Object{$_.handle -eq ('0x{0:X}' -f $fw)}|Select-Object -First 1);focused=$focused;windows=@($win);cursor=@{x=$pt.X;y=$pt.Y};dpi=[int]$dpi;virtualScreen=@{x=$vs.X;y=$vs.Y;width=$vs.Width;height=$vs.Height}}|ConvertTo-Json -Compress -Depth 6`;
  const out=await powershell(script,5000); const state=JSON.parse(out.trim()) as WindowsState; const current=state.foreground?.handle?.toLowerCase()??''; if(lastForegroundHandle&&current!==lastForegroundHandle) await clearUiHandles().catch(()=>undefined); lastForegroundHandle=current; return state;
}

export async function closeWindow(query:string):Promise<string>{const q=esc(query.trim());if(!q)throw new Error('Window query is required.');return powershell(`$q='${q}';$p=Get-Process|Where-Object{$_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$q*" -or $_.ProcessName -like "*$q*")}|Select-Object -First 1;if(-not$p){throw 'Window not found'};[FreeGentWin32]::PostMessage($p.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null;$p.MainWindowTitle`);}
export async function windowAction(action:'minimize'|'maximize'|'restore',query:string):Promise<string>{const q=esc(query.trim());const cmd=action==='minimize'?6:action==='maximize'?3:9;return powershell(`$q='${q}';$p=Get-Process|Where-Object{$_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$q*" -or $_.ProcessName -like "*$q*")}|Select-Object -First 1;if(-not$p){throw 'Window not found'};[FreeGentWin32]::ShowWindow($p.MainWindowHandle,${cmd})|Out-Null;$p.MainWindowTitle`);}
export async function mouse(action:'click'|'doubleClick'|'rightClick'|'middleClick'|'move'|'drag'|'scroll',args:number[]):Promise<void>{
 const[x=0,y=0,x2=0,y2=0,amount=0,duration=250]=args; if(![x,y,x2,y2,amount,duration].every(Number.isFinite))throw new Error('Mouse arguments must be finite numbers.');
 const bounds=`$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;if(${Math.round(x)} -lt $b.X -or ${Math.round(x)} -ge ($b.X+$b.Width) -or ${Math.round(y)} -lt $b.Y -or ${Math.round(y)} -ge ($b.Y+$b.Height)){throw 'Mouse target is outside the virtual desktop bounds.'}`;
 const safeDuration=Math.max(0,Math.min(120,Math.round(duration)));
 let code='';
 if(action==='move') code=`$p=New-Object FreeGentWin32+POINT;[FreeGentWin32]::GetCursorPos([ref]$p)|Out-Null;[FreeGentWin32]::SmoothMove($p.X,$p.Y,${Math.round(x)},${Math.round(y)},${safeDuration})|Out-Null;[FreeGentOverlay]::Move(${Math.round(x)},${Math.round(y)})`;
 else if(action==='scroll'){ const ticks=Math.max(1,Math.min(6,Math.ceil(Math.abs(amount)/120))); const tick=Math.round(amount/ticks); code=`1..${ticks}|%{[FreeGentWin32]::mouse_event(0x0800,0,0,${tick},[UIntPtr]::Zero);Start-Sleep -Milliseconds 45}`; }
 else if(action==='click') code=`[FreeGentWin32]::SmoothMove(([System.Windows.Forms.Cursor]::Position).X,([System.Windows.Forms.Cursor]::Position).Y,${Math.round(x)},${Math.round(y)},${safeDuration})|Out-Null;[FreeGentOverlay]::Move(${Math.round(x)},${Math.round(y)});[FreeGentOverlay]::Click();[FreeGentWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`;
 else if(action==='doubleClick') code=`[FreeGentWin32]::SmoothMove(([System.Windows.Forms.Cursor]::Position).X,([System.Windows.Forms.Cursor]::Position).Y,${Math.round(x)},${Math.round(y)},${safeDuration})|Out-Null;[FreeGentOverlay]::Move(${Math.round(x)},${Math.round(y)});1..2|%{[FreeGentWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 60}`;
 else if(action==='rightClick') code=`[FreeGentWin32]::SmoothMove(([System.Windows.Forms.Cursor]::Position).X,([System.Windows.Forms.Cursor]::Position).Y,${Math.round(x)},${Math.round(y)},${safeDuration})|Out-Null;[FreeGentOverlay]::Move(${Math.round(x)},${Math.round(y)});[FreeGentWin32]::mouse_event(8,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(16,0,0,0,[UIntPtr]::Zero)`;
 else if(action==='middleClick') code=`[FreeGentWin32]::SmoothMove(([System.Windows.Forms.Cursor]::Position).X,([System.Windows.Forms.Cursor]::Position).Y,${Math.round(x)},${Math.round(y)},${safeDuration})|Out-Null;[FreeGentOverlay]::Move(${Math.round(x)},${Math.round(y)});[FreeGentWin32]::mouse_event(32,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(64,0,0,0,[UIntPtr]::Zero)`;
 else if(action==='drag') code=`[FreeGentWin32]::SmoothMove(([System.Windows.Forms.Cursor]::Position).X,([System.Windows.Forms.Cursor]::Position).Y,${Math.round(x)},${Math.round(y)},${safeDuration})|Out-Null;[FreeGentWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 40;[FreeGentWin32]::SmoothMove(${Math.round(x)},${Math.round(y)},${Math.round(x2)},${Math.round(y2)},${Math.max(40,Math.min(500,Math.round(duration)))})|Out-Null;[FreeGentWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`;
 if(action==='drag' && (Math.round(x2) < 0 || Math.round(y2) < 0)) throw new Error('Invalid drag target.');
 await powershell(`${bounds};${code}`);
}

// --- Convenience aliases -----------------------------------------------
// mouse() is the canonical primitive; these exist only because some callers
// (visionLoop.ts) expect one-verb-per-function names instead of an action
// string. Keep them thin — no logic lives here, so there's exactly one
// implementation of each gesture to maintain.
export async function moveMouse(x: number, y: number, duration = 250): Promise<void> { return mouse('move', [x, y, 0, 0, 0, duration]); }
export async function click(button: 'left' | 'right' | 'middle' | string, x: number, y: number, duration = 250): Promise<void> {
  const kind = button === 'right' ? 'rightClick' : button === 'middle' ? 'middleClick' : 'click';
  return mouse(kind, [x, y, 0, 0, 0, duration]);
}
export async function doubleClick(x: number, y: number, duration = 250): Promise<void> { return mouse('doubleClick', [x, y, 0, 0, 0, duration]); }
export async function rightClick(x: number, y: number, duration = 250): Promise<void> { return mouse('rightClick', [x, y, 0, 0, 0, duration]); }
export async function drag(x: number, y: number, x2: number, y2: number, duration = 250): Promise<void> { return mouse('drag', [x, y, x2, y2, 0, duration]); }

export interface Screenshot { path: string; width: number; height: number; base64: string; }

/**
 * Raw full-screen capture with dimensions and base64 data, for a vision
 * loop that sends the image straight to a multimodal model call. Prefer
 * captureScreen() / captureAnnotatedScreen() from vision/screen.ts for
 * anything UIA/OCR/agent-loop related — they add hash-based caching so
 * repeated observes don't re-capture and re-OCR an unchanged screen. This
 * exists only so callers that already import from windows/computer.ts
 * (like visionLoop.ts) don't need a second import path; it does NOT import
 * vision/screen.ts, to avoid a cycle (vision/screen.ts imports several
 * things FROM this file already).
 */
export async function captureScreenshot(): Promise<Screenshot> {
  if (process.platform !== 'win32') throw new Error('Screen capture currently requires Windows');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { readFile } = await import('node:fs/promises');
  const out = join(tmpdir(), `freegent-shot-${Date.now()}.png`);
  await powerShellCapture(out);
  const buf = await readFile(out);
  if (buf.length < 24) throw new Error('Invalid PNG produced by screen capture.');
  // PNG IHDR is a fixed layout; reading it directly avoids pulling in an
  // image library just for width/height.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { path: out, width, height, base64: buf.toString('base64') };
}

type VirtualKeyName = string;
const VK: Record<string, number> = {
 'BACKSPACE':0x08,'TAB':0x09,'ENTER':0x0D,'SHIFT':0x10,'CTRL':0x11,'ALT':0x12,'PAUSE':0x13,'CAPSLOCK':0x14,'ESC':0x1B,'ESCAPE':0x1B,
 'SPACE':0x20,'PAGEUP':0x21,'PAGEDOWN':0x22,'END':0x23,'HOME':0x24,'LEFT':0x25,'UP':0x26,'RIGHT':0x27,'DOWN':0x28,'INSERT':0x2D,'DELETE':0x2E,
 '0':0x30,'1':0x31,'2':0x32,'3':0x33,'4':0x34,'5':0x35,'6':0x36,'7':0x37,'8':0x38,'9':0x39,
 'A':0x41,'B':0x42,'C':0x43,'D':0x44,'E':0x45,'F':0x46,'G':0x47,'H':0x48,'I':0x49,'J':0x4A,'K':0x4B,'L':0x4C,'M':0x4D,'N':0x4E,'O':0x4F,'P':0x50,'Q':0x51,'R':0x52,'S':0x53,'T':0x54,'U':0x55,'V':0x56,'W':0x57,'X':0x58,'Y':0x59,'Z':0x5A,
 'NUM0':0x60,'NUM1':0x61,'NUM2':0x62,'NUM3':0x63,'NUM4':0x64,'NUM5':0x65,'NUM6':0x66,'NUM7':0x67,'NUM8':0x68,'NUM9':0x69,
 'F1':0x70,'F2':0x71,'F3':0x72,'F4':0x73,'F5':0x74,'F6':0x75,'F7':0x76,'F8':0x77,'F9':0x78,'F10':0x79,'F11':0x7A,'F12':0x7B,
};
function normalizeKeyName(value:string):string { const k=value.trim().toUpperCase().replace(/\s+/g,''); return k==='RETURN'?'ENTER':k; }
function vkFor(value:VirtualKeyName):number { const k=normalizeKeyName(value); const hit=VK[k]; if(hit===undefined) throw new Error(`Unsupported key: ${value}`); return hit; }
function powershellKeyScript(value:string):string {
 const parts=value.split(/\s*\+\s*/).map(s=>s.trim()).filter(Boolean);
 if(parts.length<=1){ const vk=vkFor(value); return `[FreeGentWin32]::TapVirtualKey(${vk})`; }
 const vks=parts.map(vkFor);
 const downs=vks.map(v=>`[FreeGentWin32]::SendVirtualKey(${v},$true)`).join(';');
 const ups=vks.slice().reverse().map(v=>`[FreeGentWin32]::SendVirtualKey(${v},$false)`).join(';');
 return `${downs};Start-Sleep -Milliseconds 20;${ups}`;
}
export async function keyboard(action:'type'|'key'|'hotkey',value:string):Promise<void>{
 if(action==='type'){
  const b=Buffer.from(value,'utf8').toString('base64');
  await powershell(`[FreeGentWin32]::SendUnicodeText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b}')))` ,5000);
  return;
 }
 await powershell(powershellKeyScript(value),5000);
}

export interface ComputerBatchAction { action:'click'|'doubleClick'|'rightClick'|'middleClick'|'move'|'drag'|'scroll'|'type'|'key'|'hotkey'; x?:number;y?:number;x2?:number;y2?:number;amount?:number;duration?:number;text?:string;value?:string;key?:string;keys?:string; }
export async function computerBatch(actions:ComputerBatchAction[]):Promise<void>{
 if(!actions.length) throw new Error('computer batch requires at least one action');
 if(actions.length>40) throw new Error('computer batch is limited to 40 actions');
 const pieces:string[]=[];
 for(const a of actions){
  if(['key','hotkey'].includes(a.action)){ pieces.push(powershellKeyScript(String(a.value ?? a.keys ?? ''))); continue; }
  if(a.action==='type'){ const b=Buffer.from(String(a.text ?? ''),'utf8').toString('base64'); pieces.push(`[FreeGentWin32]::SendUnicodeText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b}')))`,); continue; }
  const nums=[a.x ?? 0,a.y ?? 0,a.x2 ?? 0,a.y2 ?? 0,a.amount ?? 0,a.duration ?? 0];
  if(!nums.slice(0,2).every(Number.isFinite)) throw new Error('computer batch mouse action requires finite x/y');
  const [x,y,x2,y2,amount,duration]=nums.map(Math.round);
  if(a.action==='move') pieces.push(`[FreeGentWin32]::SetCursorPos(${x},${y})|Out-Null`);
  else if(a.action==='scroll'){ const ticks=Math.max(1,Math.min(6,Math.ceil(Math.abs(amount)/120))); const tick=Math.round(amount/ticks); pieces.push(`1..${ticks}|%{[FreeGentWin32]::mouse_event(0x0800,0,0,${tick},[UIntPtr]::Zero);Start-Sleep -Milliseconds 35}`); }
  else if(a.action==='click') pieces.push(`[FreeGentWin32]::SetCursorPos(${x},${y})|Out-Null;[FreeGentWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`);
  else if(a.action==='doubleClick') pieces.push(`[FreeGentWin32]::SetCursorPos(${x},${y})|Out-Null;1..2|%{[FreeGentWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 45}`);
  else if(a.action==='rightClick') pieces.push(`[FreeGentWin32]::SetCursorPos(${x},${y})|Out-Null;[FreeGentWin32]::mouse_event(8,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(16,0,0,0,[UIntPtr]::Zero)`);
  else if(a.action==='middleClick') pieces.push(`[FreeGentWin32]::SetCursorPos(${x},${y})|Out-Null;[FreeGentWin32]::mouse_event(32,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(64,0,0,0,[UIntPtr]::Zero)`);
  else if(a.action==='drag') pieces.push(`[FreeGentWin32]::SetCursorPos(${x},${y})|Out-Null;[FreeGentWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 30;[FreeGentWin32]::SmoothMove(${x},${y},${x2},${y2},${Math.max(40,Math.min(500,duration||120))})|Out-Null;[FreeGentWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`);
 }
 await powershell(pieces.join(';'),Math.min(30000,5000+actions.length*500));
}

export interface UiPostcondition { ok: boolean; reason: string; value?: string; }
export async function verifyUiAction(action: string, t: UiTargetQuery, expected = ''): Promise<UiPostcondition> {
 const target = await findUiElement(t);
 if (!target) return { ok: false, reason: 'UI target is no longer available; it may be stale.' };
 if (action === 'setValue') return target.value === expected ? { ok: true, reason: 'ValuePattern value matches the requested value.', value: target.value } : { ok: false, reason: `ValuePattern value mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(target.value ?? '')}.`, value: target.value };
 if (action === 'getValue') return { ok: true, reason: 'Value read completed.', value: target.value };
 if (action === 'focus') {
   const state = await windowsState(); const f = state.focused;
   const nameOk = !t.name || f?.name === t.name; const idOk = !t.automationId || f?.automationId === t.automationId;
   return nameOk && idOk ? { ok: true, reason: 'Focused element matches the requested target.' } : { ok: false, reason: 'Requested UI target is not the focused element.' };
 }
 return { ok: true, reason: `UIA ${action} completed; no stronger semantic verifier is available for this operation.` };
}

export async function frameHashRect(x:number,y:number,width:number,height:number):Promise<string>{return (await powershell(`[FreeGentWin32]::FrameHashRect(${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)})`)).trim();}
export async function captureWindow(path:string,handle:string):Promise<void>{await powershell(`[FreeGentWin32]::CaptureWindow('${esc(path)}',[IntPtr]::new([Int64]([Convert]::ToInt64('${esc(handle)}',16))))`,30000);}
export async function overlayStart():Promise<void>{await powershell('[FreeGentOverlay]::Start()');}
export async function overlayMove(x:number,y:number):Promise<void>{await powershell(`[FreeGentOverlay]::Move(${Math.round(x)},${Math.round(y)})`);}
export async function overlayStop():Promise<void>{await powershell('[FreeGentOverlay]::Stop()');}
export async function clearUiHandles():Promise<void>{await powershell('Clear-FreeGentHandles');}
export async function settleDesktop(maxMs=1000):Promise<void>{const deadline=Date.now()+Math.max(100,Math.min(maxMs,3000));let prev='';while(Date.now()<deadline){const h=(await powershell('[FreeGentWin32]::FrameHash()')).trim();if(h&&h===prev)return;prev=h;await new Promise(r=>setTimeout(r,110));}}
const UIA='';
function uiRootScript(windowQuery:string = ''):string{if(!windowQuery)return `$h=[FreeGentWin32]::GetForegroundWindow();if($h -eq [IntPtr]::Zero){throw 'No foreground window.'};$root=[System.Windows.Automation.AutomationElement]::FromHandle($h);`;const q=esc(windowQuery.trim());return `$q='${q}';$fw=[System.Windows.Automation.AutomationElement]::RootElement;$match=$fw.FindFirst([System.Windows.Automation.TreeScope]::Children,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$q,[System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)));if($null-eq$match){$match=$fw.FindFirst([System.Windows.Automation.TreeScope]::Children,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$q)))};if($null-eq$match){throw 'Window not found.'};$root=$match;`}
export async function uiTree(maxDepth=5,windowQuery=''):Promise<UiElement[]>{const depth=Math.min(Math.max(maxDepth,1),10);const script=`${UIA}${uiRootScript(windowQuery)}$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker;function Walk($e,$d){if($null-eq$e-or$d-gt${depth}){return};try{$r=$e.Current;$b=$r.BoundingRectangle;if($r.IsOffscreen-eq$false-or$r.Name){$patterns=@();foreach($p in @([System.Windows.Automation.InvokePattern]::Pattern,[System.Windows.Automation.ValuePattern]::Pattern,[System.Windows.Automation.TogglePattern]::Pattern,[System.Windows.Automation.ExpandCollapsePattern]::Pattern,[System.Windows.Automation.SelectionItemPattern]::Pattern,[System.Windows.Automation.ScrollItemPattern]::Pattern,[System.Windows.Automation.RangeValuePattern]::Pattern,[System.Windows.Automation.TextPattern]::Pattern)){try{[void]$e.GetCurrentPattern($p);$patterns+=$p.ProgrammaticName}catch{}};[pscustomobject]@{type=$r.ControlType.ProgrammaticName;name=$r.Name;automationId=$r.AutomationId;className=$r.ClassName;x=[int]$b.X;y=[int]$b.Y;width=[int]$b.Width;height=[int]$b.Height;enabled=$r.IsEnabled;offscreen=$r.IsOffscreen;patterns=$patterns;depth=$d}|ConvertTo-Json -Compress};$c=$walker.GetFirstChild($e);while($c){Walk$c($d+1);$c=$walker.GetNextSibling($c)}}catch{}};Walk$root 0`;const out=await powershell(script,60000);return out.split(/\r?\n/).map(l=>{try{return JSON.parse(l) as UiElement}catch{return null}}).filter(Boolean) as UiElement[];}
export interface UiTargetQuery{name?:string;nameContains?:string;automationId?:string;className?:string;type?:string;index?:number;window?:string;handle?:string;}
function conditions(t:UiTargetQuery):string{const p:string[]=[];if(t.name)p.push(`(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'${esc(t.name)}',[System.Windows.Automation.PropertyConditionFlags]::IgnoreCase))`);if(t.automationId)p.push(`(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'${esc(t.automationId)}'))`);if(t.className)p.push(`(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'${esc(t.className)}'))`);if(t.type){const type=validateUiControlType(t.type);p.push(`(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::${type}))`);}if(!p.length)throw new Error('A UI target requires a semantic selector.');return p.length>1?`(New-Object System.Windows.Automation.AndCondition(@(${p.join(',')})))`:p[0];}
async function locate(t:UiTargetQuery):Promise<string>{if(t.handle)return `$e=Get-FreeGentHandle '${esc(t.handle)}';`;const c=conditions(t);const idx=Math.max(0,Math.floor(t.index??0));return `${uiRootScript(t.window)}$items=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,${c});${t.nameContains?`$items=@($items|Where-Object{$_.Current.Name-like'*${esc(t.nameContains)}*'});`:''}if($items.Count-le${idx}){throw 'UI target not found.'};$e=$items.Item(${idx});`; }
export async function findUiElement(t:UiTargetQuery):Promise<UiElement|null>{const out=await powershell(`${await locate(t)}$r=$e.Current;$b=$r.BoundingRectangle;$h=Set-FreeGentHandle $e;$v='';try{$v=($e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value}catch{};[pscustomobject]@{handle=$h;type=$r.ControlType.ProgrammaticName;name=$r.Name;automationId=$r.AutomationId;className=$r.ClassName;x=[int]$b.X;y=[int]$b.Y;width=[int]$b.Width;height=[int]$b.Height;enabled=$r.IsEnabled;offscreen=$r.IsOffscreen;value=$v;patterns=@()}|ConvertTo-Json -Compress`,30000);try{return JSON.parse(out.split(/\r?\n/)[0]) as UiElement}catch{return null;}}
export type UiAction='invoke'|'focus'|'setValue'|'getValue'|'setRange'|'toggle'|'expand'|'collapse'|'select'|'scrollIntoView'|'click'|'doubleClick'|'rightClick'|'type'|'paste';
export async function uiAction(action:UiAction,t:UiTargetQuery,value=''):Promise<string>{const b64=Buffer.from(value,'utf8').toString('base64');const script=`${await locate(t)}$r=$e.Current;if(-not$r.IsEnabled-and'${action}'-notin@('focus','scrollIntoView')){throw'UI target is disabled.'};switch('${action}'){'focus'{$e.SetFocus();break}'invoke'{($e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke();break}'setValue'{($e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')));break}'getValue'{break}'setRange'{($e.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)).SetValue([double]::Parse('${esc(value)}',[Globalization.CultureInfo]::InvariantCulture));break}'toggle'{($e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Toggle();break}'expand'{($e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand();break}'collapse'{($e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Collapse();break}'select'{($e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select();break}'scrollIntoView'{($e.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)).ScrollIntoView();break}'type'{$e.SetFocus();$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));[System.Windows.Forms.Clipboard]::SetText($s);[System.Windows.Forms.SendKeys]::SendWait('^v');break}'paste'{$e.SetFocus();[System.Windows.Forms.Clipboard]::SetText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')));[System.Windows.Forms.SendKeys]::SendWait('^v');break}'click'{$bb=$r.BoundingRectangle;[FreeGentWin32]::SetCursorPos([int]($bb.X+$bb.Width/2),[int]($bb.Y+$bb.Height/2))|Out-Null;[FreeGentWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero);break}'doubleClick'{$bb=$r.BoundingRectangle;[FreeGentWin32]::SetCursorPos([int]($bb.X+$bb.Width/2),[int]($bb.Y+$bb.Height/2))|Out-Null;1..2|%{[FreeGentWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 60};break}'rightClick'{$bb=$r.BoundingRectangle;[FreeGentWin32]::SetCursorPos([int]($bb.X+$bb.Width/2),[int]($bb.Y+$bb.Height/2))|Out-Null;[FreeGentWin32]::mouse_event(8,0,0,0,[UIntPtr]::Zero);[FreeGentWin32]::mouse_event(16,0,0,0,[UIntPtr]::Zero);break}};$val='';try{$val=($e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value}catch{};[pscustomobject]@{action='${action}';name=$r.Name;type=$r.ControlType.ProgrammaticName;automationId=$r.AutomationId;value=$val}|ConvertTo-Json -Compress`;return powershell(script,30000);}
