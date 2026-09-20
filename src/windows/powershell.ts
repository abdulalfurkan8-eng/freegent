import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execa } from 'execa';

const RESULT_PREFIX = '__FREEGENT_RESULT__';
const MAX_PROTOCOL_LINE = 4 * 1024 * 1024;
const WIN32_CSHARP = String.raw`
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Collections.Generic;
public static class FreeGentWin32 {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr extra);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
 [DllImport("user32.dll")] public static extern int GetDpiForWindow(IntPtr hWnd);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs,int cbSize);
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public KEYBDINPUT ki; }
 [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
 public static void SendVirtualKey(ushort vk, bool keyDown){
  var input=new INPUT{type=1,ki=new KEYBDINPUT{wVk=vk,wScan=0,dwFlags=keyDown?0u:0x0002u}};
  if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1u) throw new InvalidOperationException("SendInput virtual key failed for VK " + vk);
 }
 public static void TapVirtualKey(ushort vk){ SendVirtualKey(vk,true); System.Threading.Thread.Sleep(12); SendVirtualKey(vk,false); }
 public static void SendUnicodeText(string text){
  var list=new List<INPUT>();
  foreach(var ch in text){
   list.Add(new INPUT{type=1,ki=new KEYBDINPUT{wScan=ch,dwFlags=0x0004}});
   list.Add(new INPUT{type=1,ki=new KEYBDINPUT{wScan=ch,dwFlags=0x0004|0x0002}});
  }
  if(list.Count>0 && SendInput((uint)list.Count,list.ToArray(),Marshal.SizeOf(typeof(INPUT)))!=(uint)list.Count) throw new InvalidOperationException("SendInput failed.");
 }
 public static string HitTest(int x,int y){ var h=WindowFromPoint(new POINT{X=x,Y=y}); return h==IntPtr.Zero?"0x0":string.Format("0x{0:X}",h.ToInt64()); }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 public static string FrameHash(){ return FrameHashRect(System.Windows.Forms.SystemInformation.VirtualScreen.X,System.Windows.Forms.SystemInformation.VirtualScreen.Y,System.Windows.Forms.SystemInformation.VirtualScreen.Width,System.Windows.Forms.SystemInformation.VirtualScreen.Height); }
 public static string FrameHashRect(int x,int y,int width,int height) {
   if(width<=0||height<=0) throw new ArgumentOutOfRangeException();
   using (var bmp=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
    using (var g=Graphics.FromImage(bmp)) { g.CopyFromScreen(x,y,0,0,bmp.Size); }
    using (var sha=SHA256.Create()) {
     var data=bmp.LockBits(new Rectangle(0,0,bmp.Width,bmp.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
     try { var bytes=Math.Abs(data.Stride)*bmp.Height; var buf=new byte[bytes]; Marshal.Copy(data.Scan0,buf,0,bytes); return BitConverter.ToString(sha.ComputeHash(buf)).Replace("-","").ToLowerInvariant(); }
     finally { bmp.UnlockBits(data); }
    }
   }
 }
 public static void CaptureScreen(string path) { var b=System.Windows.Forms.SystemInformation.VirtualScreen; CaptureRect(path,b.X,b.Y,b.Width,b.Height); }
 public static void CaptureRect(string path,int x,int y,int width,int height) {
   if(width<=0||height<=0) throw new ArgumentOutOfRangeException();
   using (var bmp=new Bitmap(width,height,PixelFormat.Format32bppArgb)) { using (var g=Graphics.FromImage(bmp)) { g.CopyFromScreen(x,y,0,0,bmp.Size); } bmp.Save(path,ImageFormat.Png); }
 }
 public static void CaptureWindow(string path,IntPtr hWnd) { RECT r; if(!GetWindowRect(hWnd,out r)) throw new InvalidOperationException("Unable to read window bounds."); CaptureRect(path,r.Left,r.Top,Math.Max(1,r.Right-r.Left),Math.Max(1,r.Bottom-r.Top)); }
 // Generalist reasoning models (unlike models trained end-to-end on GUI
 // grounding) are unreliable at estimating raw pixel coordinates from a
 // photo-like screenshot. Burning a coordinate grid into the image gives
 // the model visible anchors to read off of, which substantially improves
 // click accuracy without needing a specialized vision-grounding model.
 public static void CaptureAnnotated(string path,int x,int y,int width,int height,int spacing) {
   if(width<=0||height<=0) throw new ArgumentOutOfRangeException();
   if(spacing<20) spacing=20;
   using (var bmp=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
     using (var g=Graphics.FromImage(bmp)) {
       g.CopyFromScreen(x,y,0,0,bmp.Size);
       using (var pen=new Pen(Color.FromArgb(150,255,0,180),1))
       using (var font=new Font("Consolas",9,System.Drawing.FontStyle.Bold))
       using (var textBrush=new SolidBrush(Color.FromArgb(235,255,0,180)))
       using (var bgBrush=new SolidBrush(Color.FromArgb(170,0,0,0))) {
         for (int gx=0; gx<width; gx+=spacing) {
           g.DrawLine(pen,gx,0,gx,height);
           string label=(x+gx).ToString();
           var size=g.MeasureString(label,font);
           g.FillRectangle(bgBrush,gx+2,1,size.Width,size.Height);
           g.DrawString(label,font,textBrush,gx+2,1);
         }
         for (int gy=0; gy<height; gy+=spacing) {
           g.DrawLine(pen,0,gy,width,gy);
           string label=(y+gy).ToString();
           var size=g.MeasureString(label,font);
           g.FillRectangle(bgBrush,1,gy+1,size.Width,size.Height);
           g.DrawString(label,font,textBrush,1,gy+1);
         }
       }
     }
     bmp.Save(path,ImageFormat.Png);
   }
 }
 public static void SmoothMove(int x1,int y1,int x2,int y2,int durationMs) { durationMs=Math.Max(0,Math.Min(durationMs,1000)); int steps=Math.Max(1,Math.Min(40,durationMs/3)); for(int i=1;i<=steps;i++){ double t=(double)i/steps; t=t*t*(3-2*t); SetCursorPos((int)Math.Round(x1+(x2-x1)*t),(int)Math.Round(y1+(y2-y1)*t)); if(durationMs>0) System.Threading.Thread.Sleep(Math.Max(1,durationMs/steps)); } }
}
public static class FreeGentOverlay {
 private sealed class OverlayForm:System.Windows.Forms.Form {
  protected override System.Windows.Forms.CreateParams CreateParams { get { var cp=base.CreateParams; cp.ExStyle|=0x20|0x8000000|0x80; return cp; } }
 }
 private static OverlayForm form;
 public static void Start(){ if(form!=null&&!form.IsDisposed)return; form=new OverlayForm{FormBorderStyle=System.Windows.Forms.FormBorderStyle.None,ShowInTaskbar=false,TopMost=true,BackColor=System.Drawing.Color.Magenta,TransparencyKey=System.Drawing.Color.Magenta,Width=28,Height=28,StartPosition=System.Windows.Forms.FormStartPosition.Manual,Opacity=.92}; form.Paint+=(s,e)=>{using (var b=new System.Drawing.SolidBrush(System.Drawing.Color.DeepSkyBlue)){e.Graphics.FillEllipse(b,4,4,20,20);}using (var pen=new System.Drawing.Pen(System.Drawing.Color.White,2)){e.Graphics.DrawEllipse(pen,4,4,20,20);}}; form.Show(); Move(0,0); }
 public static void Move(int x,int y){ if(form==null||form.IsDisposed)return; form.Location=new System.Drawing.Point(x-14,y-14); form.BringToFront(); System.Windows.Forms.Application.DoEvents(); }
 public static void Click(){ if(form==null||form.IsDisposed)return; form.Invalidate(); System.Windows.Forms.Application.DoEvents(); System.Threading.Thread.Sleep(35); }
 public static void Hide(){ if(form!=null&&!form.IsDisposed)form.Hide(); }
 public static void Stop(){ if(form!=null&&!form.IsDisposed){form.Close();form.Dispose();} form=null; }
}
`;

const STARTUP = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$freeGentRefs = @([System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Bitmap].Assembly.Location, [System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location)
Add-Type -ReferencedAssemblies $freeGentRefs -TypeDefinition @'
${WIN32_CSHARP}
'@
`;


// Reuse the exact known-good bootstrap source for repair. The previous build
// referenced undefined placeholder variables (`winclass`/`overclass`), which
// caused the module to throw at import time before any command could run.
// Repair source must be pure C#. Do not wrap it in PowerShell here-string syntax
// before passing it to Add-Type -TypeDefinition.
const CUA_REPAIR = WIN32_CSHARP;

let persistent: PersistentPowerShell | null = null;
let pingTimer: NodeJS.Timeout | null = null;

class PersistentPowerShell {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending: { resolve: (v: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private chain = Promise.resolve();
  private closed = false;

  constructor() {
    this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', STARTUP + String.raw`
$script:FreeGentHandles = @{}
$script:FreeGentHandleSeq = 0
function Set-FreeGentHandle($e) { $script:FreeGentHandleSeq++; $id=('el-{0}' -f $script:FreeGentHandleSeq); $script:FreeGentHandles[$id]=$e; return $id }
function Get-FreeGentHandle($id) { if($script:FreeGentHandles.ContainsKey($id)){ return $script:FreeGentHandles[$id] }; throw 'UI element handle is stale or unknown.' }
function Clear-FreeGentHandles { $script:FreeGentHandles.Clear() }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $code = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line));
    $result = @(& ([scriptblock]::Create($code)) 2>&1 | Out-String);
    $text = ($result -join '').TrimEnd();
    [Console]::Out.WriteLine('${RESULT_PREFIX}' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)));
  } catch {
    $text = $_.Exception.Message;
    [Console]::Out.WriteLine('${RESULT_PREFIX}ERR:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)));
  }
  [Console]::Out.Flush();
}`], { windowsHide: true, stdio: 'pipe' });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.on('error', (err) => this.fail(err));
    this.child.on('exit', (code) => this.fail(new Error(`PowerShell session exited ${code ?? 'unknown'}`)));
  }
  private onData(chunk:string):void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_PROTOCOL_LINE && this.buffer.indexOf('\n') < 0) {
      this.fail(new Error(`PowerShell protocol line exceeded ${MAX_PROTOCOL_LINE} bytes.`));
      try { this.child.kill(); } catch {}
      return;
    }
    let idx:number;
    while((idx=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,idx).replace(/\r$/,''); this.buffer=this.buffer.slice(idx+1);
      if(line.length > MAX_PROTOCOL_LINE){ this.fail(new Error(`PowerShell protocol line exceeded ${MAX_PROTOCOL_LINE} bytes.`)); try { this.child.kill(); } catch {}; return; }
      if(!line.startsWith(RESULT_PREFIX)||!this.pending) continue;
      const raw=line.slice(RESULT_PREFIX.length), isErr=raw.startsWith('ERR:'), encoded=isErr?raw.slice(4):raw;
      let text=''; try{text=Buffer.from(encoded,'base64').toString('utf8')}catch{text=raw}
      const q=this.pending; this.pending=null; clearTimeout(q.timer); isErr?q.reject(new Error(text||'PowerShell command failed')):q.resolve(text);
    }
  }
  private fail(err:Error):void { if(this.closed)return; if(this.pending){const q=this.pending;this.pending=null;clearTimeout(q.timer);q.reject(err)}; this.closed=true; }
  run(script:string,timeout:number):Promise<string>{
    const job=this.chain.then(()=>new Promise<string>((resolve,reject)=>{
      if(this.closed||this.child.exitCode!==null)return reject(new Error('PowerShell session is not running'));
      const timer=setTimeout(()=>{this.pending=null;reject(new Error(`PowerShell command timed out after ${timeout}ms`));this.close()},timeout);
      this.pending={resolve,reject,timer};
      this.child.stdin.write(Buffer.from(script,'utf8').toString('base64')+'\n');
    }));
    this.chain=job.then(()=>undefined,()=>undefined); return job;
  }
  close():void { this.closed=true; if(this.pending){const q=this.pending;this.pending=null;clearTimeout(q.timer);q.reject(new Error('PowerShell session closed'))}; try{this.child.stdin.end()}catch{}; try{this.child.kill()}catch{} }
}

export async function ensureComputerRuntime(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows-only capability');
  persistent ??= new PersistentPowerShell();
  try {
    const probe = await persistent.run("if($null -eq ('FreeGentWin32' -as [type])){'missing'}else{'ready'}", 5_000);
    if (probe.trim() === 'ready') return;
    const encoded = Buffer.from(CUA_REPAIR, 'utf8').toString('base64');
    await persistent.run(
      "$src=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')); if($null -eq ('FreeGentWin32' -as [type])){ try { Add-Type -TypeDefinition $src -ErrorAction Stop } catch { throw ((($_ | Out-String).Trim())) } }; if($null -eq ('FreeGentWin32' -as [type])){throw 'FreeGentWin32 repair failed.'}",
      15_000,
    );
    const verified = await persistent.run("if($null -eq ('FreeGentWin32' -as [type])){'missing'}else{'ready'}", 5_000);
    if (verified.trim() !== 'ready') throw new Error('FreeGentWin32 is unavailable after repair.');
  } catch (err) {
    try { persistent?.close(); } catch {}
    persistent = null;
    throw err;
  }
}

export async function powershell(script:string,timeout=30_000):Promise<string>{
  if(process.platform!=='win32')throw new Error('Windows-only capability');
  persistent ??= new PersistentPowerShell();
  try{return await persistent.run(script,timeout)}catch(err){
    // Respawn once; do not silently fall back to per-action process churn.
    try{persistent.close()}catch{}; persistent=null;
    throw err;
  }
}
export async function powerShellFrameHash():Promise<string>{ return (await powershell('[FreeGentWin32]::FrameHash()')).trim(); }
export async function powerShellCapture(path:string):Promise<void>{ const q=path.replace(/'/g,"''"); await powershell(`[FreeGentWin32]::CaptureScreen('${q}')`,30_000); }
export async function powerShellCaptureAnnotated(path:string,x:number,y:number,width:number,height:number,spacing=100):Promise<void>{ const q=path.replace(/'/g,"''"); await powershell(`[FreeGentWin32]::CaptureAnnotated('${q}',${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)},${Math.round(spacing)})`,30_000); }
export function closePowerShell():void { if(pingTimer){clearInterval(pingTimer);pingTimer=null}; persistent?.close(); persistent=null; }

// Cheap keepalive prevents an idle session from being surprised by the next action.
export function startPowerShellKeepalive():void { if(process.platform!=='win32'||pingTimer)return; pingTimer=setInterval(()=>{ powerShellFrameHash().catch(()=>undefined) },30_000); pingTimer.unref?.(); }
