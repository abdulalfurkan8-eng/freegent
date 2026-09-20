<#
  overlay.ps1 - the "blue AI cursor" for computer use.

  A transparent, always-on-top, click-through window that shows where the AI
  is acting in real time: a glossy blue pointer that glides to each target and
  ripples on click/scroll/drag. Mirrors the on-screen cursor Codex shows during
  computer use so the user can watch what the agent is doing.

  Rendering uses a per-pixel-alpha layered window (UpdateLayeredWindow) so the
  pointer has smooth anti-aliased edges and a soft shadow with no color-key
  fringing.

  Driven by a small state file written by cua.ps1:
    %TEMP%\cua\overlay.json  = { x, y, action, seq, visible, ts }
  Stops when %TEMP%\cua\overlay.stop appears (or after an idle timeout).
  Started/stopped via `cua.ps1 overlay-start|overlay-stop`.
#>
[CmdletBinding()]
param(
  [int]$IdleTimeoutSec = 900
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OverlayWin {
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr sect, uint off);
  [DllImport("user32.dll", SetLastError=true)] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINT pDst, ref SIZE size, IntPtr src, ref POINT pSrc, int key, ref BLENDFUNCTION blend, int flags);
  public static int GetEx(IntPtr h) { return GetWindowLong(h, GWL_EXSTYLE); }

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; }
  [StructLayout(LayoutKind.Sequential, Pack=1)] public struct BLENDFUNCTION { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER { public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount; public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter; public uint biClrUsed; public uint biClrImportant; }

  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_LAYERED = 0x80000;
  public const int WS_EX_TRANSPARENT = 0x20;
  public const int WS_EX_TOOLWINDOW = 0x80;
  public const int WS_EX_NOACTIVATE = 0x8000000;

  public static void Dpi() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {}
    try { SetProcessDPIAware(); } catch {}
  }
  public static void MakeClickThrough(IntPtr h) {
    int ex = GetWindowLong(h, GWL_EXSTYLE);
    ex |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    SetWindowLong(h, GWL_EXSTYLE, ex);
  }
  // Push premultiplied BGRA pixels to the layered window at screen (x,y) via a
  // top-down 32bpp DIB section (GetHbitmap loses alpha, so we build a DIB).
  public static int Paint(IntPtr hwnd, byte[] bgra, int w, int h, int x, int y) {
    IntPtr mem = CreateCompatibleDC(IntPtr.Zero);
    BITMAPINFOHEADER bi = new BITMAPINFOHEADER();
    bi.biSize = 40; bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32; bi.biCompression = 0;
    IntPtr bits;
    IntPtr dib = CreateDIBSection(mem, ref bi, 0, out bits, IntPtr.Zero, 0);
    Marshal.Copy(bgra, 0, bits, bgra.Length);
    IntPtr old = SelectObject(mem, dib);
    SIZE size = new SIZE(); size.cx = w; size.cy = h;
    POINT src = new POINT(); src.x = 0; src.y = 0;
    POINT dst = new POINT(); dst.x = x; dst.y = y;
    BLENDFUNCTION bf = new BLENDFUNCTION();
    bf.BlendOp = 0; bf.BlendFlags = 0; bf.SourceConstantAlpha = 255; bf.AlphaFormat = 1; // AC_SRC_ALPHA
    bool ok = UpdateLayeredWindow(hwnd, IntPtr.Zero, ref dst, ref size, mem, ref src, 0, ref bf, 2); // ULW_ALPHA
    int err = ok ? 0 : Marshal.GetLastWin32Error();
    SelectObject(mem, old);
    DeleteObject(dib);
    DeleteDC(mem);
    return err;
  }
}
'@

Add-Type -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing') @'
using System;
using System.Windows.Forms;
// Bake the layered/click-through ex-styles into the window at creation so they
// are not clobbered after HandleCreated and so the first UpdateLayeredWindow
// locks per-pixel-alpha mode (avoids error 87).
public class LayeredForm : Form {
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000; // LAYERED|TRANSPARENT|TOOLWINDOW|NOACTIVATE
      return cp;
    }
  }
  protected override void OnPaintBackground(PaintEventArgs e) { }
}
'@

[OverlayWin]::Dpi()

$dir = Join-Path $env:TEMP 'cua'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stateFile = Join-Path $dir 'overlay.json'
$stopFile = Join-Path $dir 'overlay.stop'
if (Test-Path $stopFile) { Remove-Item $stopFile -Force -ErrorAction SilentlyContinue }

$sz = 128
$half = [int]($sz / 2)

$form = New-Object LayeredForm
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.Size = New-Object System.Drawing.Size($sz, $sz)
$form.Text = 'cua-overlay'

$script:cx = $null; $script:cy = $null
$script:tx = 0; $script:ty = 0
$script:seq = -1
$script:action = 'move'
$script:visible = $true
$script:rippleStart = -100000
$script:haveTarget = $false
$script:shown = $false
$script:lastActionTick = -1
$script:autoHideMs = 2500

# Render the cursor into a premultiplied-ARGB bitmap (true alpha, no fringing).
function Render-Cursor([int]$rippleElapsed) {
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $cxp = $half; $cyp = $half

  # click / action ripple: two soft ease-out rings
  if ($rippleElapsed -ge 0 -and $rippleElapsed -le 520) {
    $t = $rippleElapsed / 520.0
    $ease = 1 - [Math]::Pow(1 - $t, 3)
    foreach ($ring in @(@(16, 52), @(9, 32))) {
      $r = [double]($ring[0] + $ease * $ring[1])
      $alpha = [int]((1.0 - $t) * 150)
      if ($alpha -gt 0) {
        $penR = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($alpha, 40, 150, 255)), 2.5
        $g.DrawEllipse($penR, ($cxp - $r), ($cyp - $r), (2 * $r), (2 * $r))
        $penR.Dispose()
      }
    }
  }

  # arrow path: tip at (cxp,cyp), body down-right
  $sc = 2.0
  $raw = @(@(0,0),@(0.4,16),@(4.2,12.3),@(7.0,19.4),@(9.6,18.3),@(6.6,11.2),@(12.4,11.0))
  $pts = @()
  foreach ($p in $raw) { $pts += (New-Object System.Drawing.PointF (($cxp + $p[0] * $sc), ($cyp + $p[1] * $sc))) }
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddPolygon([System.Drawing.PointF[]]$pts)
  $path.CloseFigure()

  # soft drop shadow: layered translucent offset passes
  foreach ($off in @(@(2.6, 3.4, 42), @(1.6, 2.2, 42), @(0.8, 1.1, 38))) {
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.Translate([single]$off[0], [single]$off[1])
    $sp = $path.Clone()
    $sp.Transform($m)
    $sb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([int]$off[2], 0, 18, 55))
    $g.FillPath($sb, $sp)
    $sb.Dispose(); $sp.Dispose(); $m.Dispose()
  }

  # glossy blue fill (vertical gradient) + crisp white rim
  $b = $path.GetBounds()
  $rect = New-Object System.Drawing.RectangleF ($b.X, ($b.Y - 1), [Math]::Max($b.Width, 1), [Math]::Max($b.Height + 2, 1))
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ($rect, ([System.Drawing.Color]::FromArgb(255, 94, 178, 255)), ([System.Drawing.Color]::FromArgb(255, 18, 102, 234)), 90)
  $g.FillPath($grad, $path)
  $grad.Dispose()

  $rim = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(245, 255, 255, 255)), 1.8
  $rim.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($rim, $path)
  $rim.Dispose()

  # specular highlight near the tip
  $hi = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(95, 255, 255, 255))
  $g.FillEllipse($hi, ($cxp + 1.5), ($cyp + 3.5), 5, 9)
  $hi.Dispose()

  $path.Dispose()
  $g.Dispose()
  return $bmp
}

function Push-Frame([int]$lx, [int]$ly, [int]$rippleElapsed) {
  $bmp = Render-Cursor $rippleElapsed
  $rect = New-Object System.Drawing.Rectangle (0, 0, $sz, $sz)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
  try {
    $len = [Math]::Abs($data.Stride) * $sz
    $buf = New-Object byte[] $len
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $len)
  } finally { $bmp.UnlockBits($data) }
  $bmp.Dispose()
  [void][OverlayWin]::Paint($form.Handle, $buf, $sz, $sz, $lx, $ly)
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 16
$timer.Add_Tick({
  if (Test-Path $stopFile) {
    Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
    $timer.Stop(); $form.Close(); return
  }
  if (Test-Path $stateFile) {
    try {
      $age = ((Get-Date).ToUniversalTime() - (Get-Item $stateFile).LastWriteTimeUtc).TotalSeconds
      if ($age -gt $IdleTimeoutSec) { $timer.Stop(); $form.Close(); return }
      $st = Get-Content $stateFile -Raw -ErrorAction Stop | ConvertFrom-Json
      $script:tx = [int]$st.x; $script:ty = [int]$st.y
      $script:action = [string]$st.action
      $script:visible = [bool]$st.visible
      $script:haveTarget = $true
      if ([int]$st.seq -ne $script:seq) {
        $script:seq = [int]$st.seq
        # only real actions bump seq; visibility toggles from screenshots do not
        $script:lastActionTick = [Environment]::TickCount
        if ($script:action -ne 'move') { $script:rippleStart = [Environment]::TickCount }
      }
    } catch { }
  }

  if (-not $script:haveTarget) { return }

  if (-not $script:visible) {
    if ($script:shown) { [OverlayWin]::ShowWindow($form.Handle, 0) | Out-Null; $script:shown = $false } # SW_HIDE
    return
  }

  # auto-recall: vanish shortly after the last action; reappear on the next one
  if ($script:lastActionTick -ge 0 -and ([Environment]::TickCount - $script:lastActionTick) -gt $script:autoHideMs) {
    if ($script:shown) { [OverlayWin]::ShowWindow($form.Handle, 0) | Out-Null; $script:shown = $false }
    $script:cx = $null; $script:cy = $null  # next action: appear at the target, no glide from stale spot
    return
  }

  if ($null -eq $script:cx) { $script:cx = $script:tx; $script:cy = $script:ty }
  else {
    $script:cx = $script:cx + ($script:tx - $script:cx) * 0.35
    $script:cy = $script:cy + ($script:ty - $script:cy) * 0.35
  }
  $lx = [int][Math]::Round($script:cx) - $half
  $ly = [int][Math]::Round($script:cy) - $half

  if (-not $script:shown) { [OverlayWin]::ShowWindow($form.Handle, 8) | Out-Null; $script:shown = $true } # SW_SHOWNA
  $rip = [Environment]::TickCount - $script:rippleStart
  Push-Frame $lx $ly $rip
})

$form.Add_Shown({
  [OverlayWin]::ShowWindow($form.Handle, 0) | Out-Null  # start hidden until first target
  $script:shown = $false
  $timer.Start()
})

[void][System.Windows.Forms.Application]::Run($form)
