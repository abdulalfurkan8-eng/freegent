<#
  cua.ps1 - zero-dependency Windows computer-use executor.
  Reimplements the OpenAI Codex CUA (@oai/sky) full-desktop action space on
  Cursor primitives: screenshot + click/move/drag/scroll/type/key.

  The agent is the "brain" (reads the screenshot PNG, decides the action).
  This script is the "hands". Screenshot pixels and click coordinates share
  one per-monitor-DPI-aware virtual-screen coordinate space.

  Usage (one action per invocation):
    cua.ps1 screenshot [-Path out.png]
    cua.ps1 click   -X 100 -Y 200 [-Button left|right|middle] [-Count 1] [-Key "Ctrl"] [-Duration 0]
    cua.ps1 move    -X 100 -Y 200
    cua.ps1 type    -Text "hello world"
    cua.ps1 key     -Key "Ctrl+a"   (X-keysym-ish names: Return, Tab, space, Control_L, Super_L, ...)
    cua.ps1 scroll  -Direction up|down|left|right [-Pixels 300] [-X 100 -Y 200]
    cua.ps1 drag    -Path "100,200 400,200 400,500"
    cua.ps1 pos
    cua.ps1 size
    cua.ps1 overlay-start        (show the blue AI cursor)
    cua.ps1 overlay-stop         (hide it)
    cua.ps1 screenshot -Raw      (include the blue cursor in the shot)
    cua.ps1 find-window [-Title 微信] [-ProcessName Weixin]
    cua.ps1 framehash  [-Title 微信] [-ProcessName Weixin] [-Region full|nav|session|chat|composer|all] [-HashSize 16]
    cua.ps1 screenshot [-Title 微信] [-ProcessName Weixin]   (crop to that window)
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet('screenshot','click','move','type','paste','key','scroll','drag','pos','size','overlay-start','overlay-stop','find-window','framehash','focus-window','list-windows','hittest','resize-window','server')]
  [string]$Command,

  [int]$X = [int]::MinValue,
  [int]$Y = [int]::MinValue,
  [string]$Button = 'left',
  [int]$Count = 1,
  [string]$Key = '',
  [int]$Duration = 0,
  [string]$Text = '',
  [string]$Direction = 'down',
  [int]$Pixels = 300,
  [string]$Path = '',
  [string]$DragPath = '',
  [string]$Title = '',
  [string]$ProcessName = '',
  [string]$Region = 'all',
  [int]$HashSize = 16,
  [int]$Width = 0,
  [int]$Height = 0,
  [switch]$Raw
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $OutputEncoding = [Console]::OutputEncoding
} catch { }

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Cua {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
  const int WHEEL_DELTA = 120;

  public static void Dpi() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } // PER_MONITOR_AWARE_V2
    catch { }
    try { SetProcessDPIAware(); } catch { }
  }

  public static POINT Pos() { POINT p; GetCursorPos(out p); return p; }
  public static int[] Virt() {
    return new int[] {
      GetSystemMetrics(76), GetSystemMetrics(77), // SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN
      GetSystemMetrics(78), GetSystemMetrics(79)  // SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN
    };
  }

  static void Mouse(uint flags, uint data) {
    INPUT[] a = new INPUT[1];
    a[0].type = INPUT_MOUSE;
    a[0].U.mi = new MOUSEINPUT { dwFlags = flags, mouseData = data };
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }

  static void Vk(ushort vk, bool up, bool ext) {
    INPUT[] a = new INPUT[1];
    a[0].type = INPUT_KEYBOARD;
    uint f = 0;
    if (up) f |= KEYEVENTF_KEYUP;
    if (ext) f |= KEYEVENTF_EXTENDEDKEY;
    a[0].U.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = f };
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }

  static void Uni(ushort code, bool up) {
    INPUT[] a = new INPUT[1];
    a[0].type = INPUT_KEYBOARD;
    uint f = KEYEVENTF_UNICODE;
    if (up) f |= KEYEVENTF_KEYUP;
    a[0].U.ki = new KEYBDINPUT { wVk = 0, wScan = code, dwFlags = f };
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }

  static readonly Random Rng = new Random();

  // Human-like pointer motion: eased quadratic bezier with micro-jitter.
  // Fast (60-190ms total) so it never hurts throughput.
  public static void HumanMove(int x, int y) {
    POINT cur; GetCursorPos(out cur);
    double dist = Math.Sqrt((x - cur.X) * (double)(x - cur.X) + (y - cur.Y) * (double)(y - cur.Y));
    if (dist < 3) { SetCursorPos(x, y); return; }
    int steps = (int)Math.Max(8, Math.Min(22, dist / 45));
    double bend = Math.Min(80, dist / 4);
    double cx = (cur.X + x) / 2.0 + (Rng.NextDouble() * 2 - 1) * bend;
    double cy = (cur.Y + y) / 2.0 + (Rng.NextDouble() * 2 - 1) * bend;
    for (int i = 1; i <= steps; i++) {
      double t = (double)i / steps;
      double te = t * t * (3 - 2 * t); // ease in-out
      double px = (1 - te) * (1 - te) * cur.X + 2 * (1 - te) * te * cx + te * te * x;
      double py = (1 - te) * (1 - te) * cur.Y + 2 * (1 - te) * te * cy + te * te * y;
      int jx = i == steps ? 0 : Rng.Next(-1, 2);
      int jy = i == steps ? 0 : Rng.Next(-1, 2);
      SetCursorPos((int)Math.Round(px) + jx, (int)Math.Round(py) + jy);
      Thread.Sleep(Rng.Next(4, 9));
    }
    SetCursorPos(x, y);
  }

  public static void Move(int x, int y) { HumanMove(x, y); }

  public static void Click(int x, int y, string button, int count, int durationMs) {
    // land within a couple of pixels of the target, like a hand would
    HumanMove(x + Rng.Next(-2, 3), y + Rng.Next(-2, 3));
    Thread.Sleep(Rng.Next(40, 110));
    uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
    if (button == "right" || button == "r") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
    else if (button == "middle" || button == "m") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
    for (int i = 0; i < count; i++) {
      Mouse(down, 0);
      Thread.Sleep(durationMs > 0 ? durationMs : Rng.Next(35, 85));
      Mouse(up, 0);
      if (i + 1 < count) Thread.Sleep(60);
    }
  }

  public static void Scroll(string dir, int pixels, bool hasXY, int x, int y) {
    if (hasXY) SetCursorPos(x, y);
    int notches = Math.Max(1, (int)Math.Round(pixels / 120.0));
    int amt = WHEEL_DELTA * notches;
    if (dir == "up" || dir == "u") Mouse(MOUSEEVENTF_WHEEL, (uint)amt);
    else if (dir == "down" || dir == "d") Mouse(MOUSEEVENTF_WHEEL, (uint)(-amt));
    else if (dir == "right" || dir == "r") Mouse(MOUSEEVENTF_HWHEEL, (uint)amt);
    else if (dir == "left" || dir == "l") Mouse(MOUSEEVENTF_HWHEEL, (uint)(-amt));
  }

  public static void Drag(POINT[] path, int stepMs) {
    if (path.Length < 2) return;
    SetCursorPos(path[0].X, path[0].Y);
    Thread.Sleep(stepMs);
    Mouse(MOUSEEVENTF_LEFTDOWN, 0);
    Thread.Sleep(stepMs);
    for (int i = 1; i < path.Length; i++) {
      SetCursorPos(path[i].X, path[i].Y);
      Thread.Sleep(stepMs);
    }
    Mouse(MOUSEEVENTF_LEFTUP, 0);
  }

  static void UniPair(ushort code) {
    // down+up MUST go in one SendInput call, or apps treat the next char as a key repeat
    INPUT[] a = new INPUT[2];
    a[0].type = INPUT_KEYBOARD;
    a[0].U.ki = new KEYBDINPUT { wVk = 0, wScan = code, dwFlags = KEYEVENTF_UNICODE };
    a[1].type = INPUT_KEYBOARD;
    a[1].U.ki = new KEYBDINPUT { wVk = 0, wScan = code, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP };
    SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void TypeText(string text) {
    foreach (char ch in text) {
      UniPair((ushort)ch);
      Thread.Sleep(10); // pace keystrokes: WeChat drops characters at full speed
    }
  }

  static bool IsExt(ushort vk) {
    // extended keys: arrows, nav cluster, right modifiers
    switch (vk) {
      case 0x21: case 0x22: case 0x23: case 0x24: // PageUp/Down, End, Home
      case 0x25: case 0x26: case 0x27: case 0x28: // arrows
      case 0x2D: case 0x2E: // Insert, Delete
        return true;
    }
    return false;
  }

  public static ushort NameToVk(string name) {
    switch (name.ToLowerInvariant()) {
      case "control": case "ctrl": case "control_l": case "ctrl_l": return 0xA2; // LCTRL
      case "control_r": case "ctrl_r": return 0xA3;
      case "alt": case "alt_l": case "menu": return 0xA4; // LMENU
      case "alt_r": case "altgr": return 0xA5;
      case "shift": case "shift_l": return 0xA0; // LSHIFT
      case "shift_r": return 0xA1;
      case "super": case "super_l": case "win": case "meta": case "cmd": return 0x5B; // LWIN
      case "super_r": case "win_r": return 0x5C;
      case "return": case "enter": case "kp_enter": return 0x0D;
      case "tab": return 0x09;
      case "space": return 0x20;
      case "backspace": return 0x08;
      case "delete": case "del": return 0x2E;
      case "escape": case "esc": return 0x1B;
      case "home": return 0x24;
      case "end": return 0x23;
      case "prior": case "pageup": case "page_up": return 0x21;
      case "next": case "pagedown": case "page_down": return 0x22;
      case "insert": return 0x2D;
      case "up": return 0x26;
      case "down": return 0x28;
      case "left": return 0x25;
      case "right": return 0x27;
      case "capslock": return 0x14;
      case "printscreen": case "print": return 0x2C;
      case "f1": return 0x70; case "f2": return 0x71; case "f3": return 0x72; case "f4": return 0x73;
      case "f5": return 0x74; case "f6": return 0x75; case "f7": return 0x76; case "f8": return 0x77;
      case "f9": return 0x78; case "f10": return 0x79; case "f11": return 0x7A; case "f12": return 0x7B;
    }
    if (name.Length == 1) {
      short s = VkKeyScan(name[0]);
      if (s != -1) return (ushort)(s & 0xFF);
    }
    return 0;
  }

  static bool IsModifier(ushort vk) {
    return vk == 0xA0 || vk == 0xA1 || vk == 0xA2 || vk == 0xA3 || vk == 0xA4 || vk == 0xA5 || vk == 0x5B || vk == 0x5C;
  }

  public static void HoldPress(string[] parts) {
    ushort[] vks = new ushort[parts.Length];
    for (int i = 0; i < parts.Length; i++) vks[i] = NameToVk(parts[i].Trim());
    for (int i = 0; i < vks.Length; i++) if (IsModifier(vks[i]) && vks[i] != 0) Vk(vks[i], false, IsExt(vks[i]));
    for (int i = 0; i < vks.Length; i++) if (!IsModifier(vks[i]) && vks[i] != 0) Vk(vks[i], false, IsExt(vks[i]));
  }

  public static void HoldRelease(string[] parts) {
    ushort[] vks = new ushort[parts.Length];
    for (int i = 0; i < parts.Length; i++) vks[i] = NameToVk(parts[i].Trim());
    for (int i = vks.Length - 1; i >= 0; i--) if (!IsModifier(vks[i]) && vks[i] != 0) Vk(vks[i], true, IsExt(vks[i]));
    for (int i = vks.Length - 1; i >= 0; i--) if (IsModifier(vks[i]) && vks[i] != 0) Vk(vks[i], true, IsExt(vks[i]));
  }

  public static void Chord(string[] parts, int durationMs) {
    HoldPress(parts);
    if (durationMs > 0) Thread.Sleep(durationMs);
    HoldRelease(parts);
  }

  static bool NameAllowed(string proc, string processName) {
    if (string.IsNullOrEmpty(processName)) return true;
    string[] parts = processName.Split(new char[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries);
    for (int i = 0; i < parts.Length; i++) {
      if (proc.Equals(parts[i].Trim(), StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }

  static bool IsCloaked(IntPtr hWnd) {
    int cloaked = 0;
    try { DwmGetWindowAttribute(hWnd, 14, out cloaked, 4); } catch { }
    return cloaked != 0;
  }

  static string FmtHit(IntPtr hWnd, string title, string proc, int pid, RECT r, string cls) {
    return string.Format("hwnd={0} title={1} process={2} pid={3} left={4} top={5} width={6} height={7} class={8} visible={9} iconic={10} cloaked={11}",
      hWnd.ToInt64(), (title ?? "").Replace(' ', '_'), proc, pid, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top,
      (cls ?? "").Replace(' ', '_'), IsWindowVisible(hWnd) ? 1 : 0, IsIconic(hWnd) ? 1 : 0, IsCloaked(hWnd) ? 1 : 0);
  }

  public static string ListWindows(string titleContains, string processName) {
    StringBuilder acc = new StringBuilder();
    EnumWindows((hWnd, l) => {
      uint pid = 0;
      GetWindowThreadProcessId(hWnd, out pid);
      string proc = "";
      try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
      StringBuilder tb = new StringBuilder(512);
      GetWindowText(hWnd, tb, 512);
      string title = tb.ToString();
      bool procOk = NameAllowed(proc, processName);
      bool titleOk = !string.IsNullOrEmpty(titleContains) && !string.IsNullOrEmpty(title) && title.IndexOf(titleContains, StringComparison.Ordinal) >= 0;
      if (!procOk && !titleOk) return true;
      RECT r;
      if (!GetWindowRect(hWnd, out r)) return true;
      int w = r.Right - r.Left, h = r.Bottom - r.Top;
      if (w < 80 || h < 80) return true;
      StringBuilder cb = new StringBuilder(256);
      GetClassName(hWnd, cb, 256);
      if (acc.Length > 0) acc.Append('\n');
      acc.Append(FmtHit(hWnd, title, proc, (int)pid, r, cb.ToString()));
      return true;
    }, IntPtr.Zero);
    return acc.ToString();
  }

  // Helper/utility windows that share the app's process but are NOT the real
  // main window. WeChat's "WxTrayIconMessageWindow" is the worst: it can appear
  // as a large blank window, and closing it quits WeChat — the agent must never
  // target it. Matched on title OR class, case-insensitive.
  public static bool IsHelperWindow(string title, string cls) {
    string t = (title ?? "").ToLowerInvariant();
    string c = (cls ?? "").ToLowerInvariant();
    string[] deny = { "wxtrayicon", "trayiconmessage", "traymessage", "trayicon",
                      "default ime", "msctfime", "ime", "tooltips_class", "olecall",
                      "hiddenwindow", "messagewnd", "message-only" };
    foreach (var d in deny) { if ((t.Length > 0 && t.Contains(d)) || (c.Length > 0 && c.Contains(d))) return true; }
    return false;
  }

  public static string FindMain(string titleContains, string processName) {
    if (!string.IsNullOrEmpty(titleContains)) {
      IntPtr direct = FindWindow(null, titleContains);
      if (direct != IntPtr.Zero) {
        RECT r0;
        if (GetWindowRect(direct, out r0) && (r0.Right - r0.Left) >= 200 && (r0.Bottom - r0.Top) >= 200) {
          uint pid0 = 0;
          GetWindowThreadProcessId(direct, out pid0);
          string proc0 = "";
          try { proc0 = System.Diagnostics.Process.GetProcessById((int)pid0).ProcessName; } catch { }
          StringBuilder c0 = new StringBuilder(256);
          GetClassName(direct, c0, 256);
          // never return a window from a process outside the allow-list, and
          // never a helper window (tray/IME/message-only)
          if (NameAllowed(proc0, processName) && !IsHelperWindow(titleContains, c0.ToString())) {
            return FmtHit(direct, titleContains, proc0, (int)pid0, r0, c0.ToString());
          }
        }
      }
    }
    long bestHwnd = 0;
    string bestTitle = "", bestProc = "", bestCls = "";
    int bestPid = 0, bestL = 0, bestT = 0, bestW = 0, bestH = 0, bestScore = int.MinValue;
    EnumWindows((hWnd, l) => {
      uint pid = 0;
      GetWindowThreadProcessId(hWnd, out pid);
      string proc = "";
      try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, 512);
      string title = sb.ToString();
      bool procOk = NameAllowed(proc, processName);
      bool titleHit = !string.IsNullOrEmpty(titleContains) && !string.IsNullOrEmpty(title) && title.IndexOf(titleContains, StringComparison.Ordinal) >= 0;
      bool weixinMain = proc.Equals("Weixin", StringComparison.OrdinalIgnoreCase) && titleHit;
      // process allow-list is mandatory; a matching title alone must never qualify
      if (!string.IsNullOrEmpty(processName)) { if (!procOk) return true; }
      else if (!titleHit) return true;
      RECT r;
      if (!GetWindowRect(hWnd, out r)) return true;
      int w = r.Right - r.Left, hgt = r.Bottom - r.Top;
      if (w < 200 || hgt < 200) return true;
      if (proc.Equals("WeChatAppEx", StringComparison.OrdinalIgnoreCase) && !titleHit) return true;
      StringBuilder clsb = new StringBuilder(256);
      GetClassName(hWnd, clsb, 256);
      // skip tray/IME/message-only helper windows (e.g. WxTrayIconMessageWindow)
      if (IsHelperWindow(title, clsb.ToString())) return true;
      int score = Math.Min(w * hgt, 1400 * 900);
      if (titleHit) score += 80 * 1000 * 1000;
      if (weixinMain) score += 40 * 1000 * 1000;
      if (IsWindowVisible(hWnd)) score += 20 * 1000 * 1000;
      if (!IsIconic(hWnd)) score += 10 * 1000 * 1000;
      if (!IsCloaked(hWnd)) score += 5 * 1000 * 1000;
      if (score > bestScore) {
        bestScore = score; bestHwnd = hWnd.ToInt64(); bestTitle = title; bestProc = proc;
        bestPid = (int)pid; bestL = r.Left; bestT = r.Top; bestW = w; bestH = hgt;
        StringBuilder cb = new StringBuilder(256);
        GetClassName(hWnd, cb, 256);
        bestCls = cb.ToString();
      }
      return true;
    }, IntPtr.Zero);
    if (bestHwnd == 0) return "";
    RECT rr = new RECT { Left = bestL, Top = bestT, Right = bestL + bestW, Bottom = bestT + bestH };
    return FmtHit(new IntPtr(bestHwnd), bestTitle, bestProc, bestPid, rr, bestCls);
  }

  public static bool FocusWindow(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (GetForegroundWindow() == h) return true;
    ShowWindow(h, 9); // SW_RESTORE
    // tap ALT to satisfy the foreground-lock heuristic, else
    // SetForegroundWindow from a background process is a silent no-op
    keybd_event(0xA4, 0, 0, UIntPtr.Zero);
    keybd_event(0xA4, 0, 2, UIntPtr.Zero);
    bool ok = SetForegroundWindow(h);
    return ok || GetForegroundWindow() == h;
  }

  // top-level window that would receive a click at screen point (x,y)
  public static long RootWindowAt(int x, int y) {
    POINT p = new POINT { X = x, Y = y };
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return 0;
    IntPtr root = GetAncestor(h, 2); // GA_ROOT
    return (root == IntPtr.Zero ? h : root).ToInt64();
  }

  public static bool ShowNoActivate(long hwnd) {
    return ShowWindow(new IntPtr(hwnd), 8); // SW_SHOWNA
  }

  public static bool ResizeWindow(long hwnd, int w, int h) {
    IntPtr hPtr = new IntPtr(hwnd);
    ShowWindow(hPtr, 9); // SW_RESTORE: a maximized window ignores SetWindowPos sizes
    // SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
    return SetWindowPos(hPtr, IntPtr.Zero, 0, 0, w, h, 0x2u | 0x4u | 0x10u);
  }

  public static Bitmap PrintCapture(long hwnd, int w, int h) {
    if (w < 1) w = 1; if (h < 1) h = 1;
    Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      try { PrintWindow(new IntPtr(hwnd), hdc, 2); } // PW_RENDERFULLCONTENT
      finally { g.ReleaseHdc(hdc); }
    }
    return bmp;
  }

  public static bool MostlyBlank(Bitmap bmp) {
    if (bmp == null || bmp.Width < 2 || bmp.Height < 2) return true;
    int[] xs = new int[] { 2, bmp.Width / 2, bmp.Width - 3 };
    int[] ys = new int[] { 2, bmp.Height / 2, bmp.Height - 3 };
    int blank = 0, n = 0;
    for (int i = 0; i < xs.Length; i++) {
      for (int j = 0; j < ys.Length; j++) {
        Color c = bmp.GetPixel(xs[i], ys[j]);
        n++;
        if (c.A < 8 || (c.R + c.G + c.B) < 12) blank++;
      }
    }
    return blank >= n - 1;
  }

  public static string AverageHash(Bitmap src, int size) {
    if (src == null || src.Width < 1 || src.Height < 1 || size < 4) return "";
    using (Bitmap small = new Bitmap(size, size)) {
      using (Graphics g = Graphics.FromImage(small)) {
        g.InterpolationMode = InterpolationMode.HighQualityBilinear;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        g.DrawImage(src, 0, 0, size, size);
      }
      int n = size * size;
      int[] gray = new int[n];
      long sum = 0;
      for (int y = 0; y < size; y++) {
        for (int x = 0; x < size; x++) {
          Color c = small.GetPixel(x, y);
          int v = (c.R * 30 + c.G * 59 + c.B * 11) / 100;
          gray[y * size + x] = v;
          sum += v;
        }
      }
      int avg = (int)(sum / n);
      StringBuilder hex = new StringBuilder((n + 3) / 4);
      int acc = 0, bits = 0;
      for (int i = 0; i < n; i++) {
        acc = (acc << 1) | (gray[i] >= avg ? 1 : 0);
        bits++;
        if (bits == 4) { hex.Append("0123456789abcdef"[acc]); acc = 0; bits = 0; }
      }
      if (bits > 0) hex.Append("0123456789abcdef"[acc << (4 - bits)]);
      return hex.ToString();
    }
  }

  // Scan the session-list band for WeChat's red unread badges (#FA5151-ish).
  // Returns comma-separated window-relative y centers, or "".
  public static string ScanBadges(Bitmap bmp) {
    // WeChat 4 layout metrics are FIXED pixels (nav rail + session list never
    // stretch), so the badge column is absolute: avatars sit at x 75-125 and
    // the unread badge overlaps their top-right corner. Fractions would drift
    // on user-resized windows.
    int x0 = 100, x1 = Math.Min(180, bmp.Width - 1);
    int y0 = 58, y1 = Math.Max(y0 + 1, bmp.Height - 12);
    StringBuilder outp = new StringBuilder();
    int runStart = -1, last = -10;
    for (int y = y0; y < y1; y++) {
      int c = 0;
      for (int x = x0; x < x1; x++) {
        Color p = bmp.GetPixel(x, y);
        if (p.R >= 200 && p.G <= 95 && p.B <= 95) c++;
      }
      bool hit = c >= 3;
      if (hit) {
        if (runStart < 0) runStart = y;
        last = y;
      } else if (runStart >= 0 && y - last > 4) {
        int h = last - runStart + 1;
        if (h >= 5 && h <= 40) {
          if (outp.Length > 0) outp.Append(',');
          outp.Append((runStart + last) / 2);
        }
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      int h = last - runStart + 1;
      if (h >= 5 && h <= 40) {
        if (outp.Length > 0) outp.Append(',');
        outp.Append((runStart + last) / 2);
      }
    }
    return outp.ToString();
  }

  // Red dot on the CONTACTS icon in the nav rail (new friend request pending).
  // Band excludes the chat icon's own unread badge above it. The rail is a
  // fixed 72px column with icons anchored to the TOP, so absolute pixels.
  public static int ScanNavBadge(Bitmap bmp) {
    int x0 = 30, x1 = Math.Min(70, bmp.Width - 1);
    int y0 = 165, y1 = Math.Min(250, bmp.Height - 1);
    int rows = 0;
    for (int y = y0; y < y1; y++) {
      int c = 0;
      for (int x = x0; x < x1; x++) {
        Color p = bmp.GetPixel(x, y);
        if (p.R >= 200 && p.G <= 95 && p.B <= 95) c++;
      }
      if (c >= 3) rows++;
    }
    return rows >= 4 ? 1 : 0;
  }

  public static Bitmap CropFrac(Bitmap src, double fx, double fy, double fw, double fh) {
    int x = (int)Math.Round(src.Width * fx);
    int y = (int)Math.Round(src.Height * fy);
    int w = (int)Math.Round(src.Width * fw);
    int h = (int)Math.Round(src.Height * fh);
    return CropRect(src, x, y, w, h);
  }

  public static Bitmap CropRect(Bitmap src, int x, int y, int w, int h) {
    if (x < 0) x = 0; if (y < 0) y = 0;
    if (x >= src.Width) x = src.Width - 1;
    if (y >= src.Height) y = src.Height - 1;
    if (x + w > src.Width) w = src.Width - x;
    if (y + h > src.Height) h = src.Height - y;
    if (w < 1) w = 1; if (h < 1) h = 1;
    return src.Clone(new Rectangle(x, y, w, h), src.PixelFormat);
  }
}
'@

[Cua]::Dpi() | Out-Null
$v = [Cua]::Virt()
$vx = $v[0]; $vy = $v[1]; $vw = $v[2]; $vh = $v[3]

function Get-AbsPoint([int]$x, [int]$y) {
  # agent coordinates are pixels within the screenshot; screenshot origin =
  # virtual-screen origin. Returns a pscustomobject (NOT an array): a helper
  # that returns a bare array, when called from the dispatch switch that now
  # lives inside a function, made PowerShell misbind the array to the next
  # [hashtable] parameter. A single object avoids that entirely.
  return [pscustomobject]@{ X = ([int]$script:vx + $x); Y = ([int]$script:vy + $y) }
}

function Parse-WinLine([string]$line) {
  $m = [regex]::Match($line, 'hwnd=(\d+)\s+title=(.*?)\s+process=(\S+)\s+pid=(\d+)\s+left=(-?\d+)\s+top=(-?\d+)\s+width=(\d+)\s+height=(\d+)')
  if (-not $m.Success) { throw "unparseable window line: $line" }
  return [pscustomobject]@{
    Hwnd = [int64]$m.Groups[1].Value
    Title = $m.Groups[2].Value
    Process = $m.Groups[3].Value
    Pid = [int]$m.Groups[4].Value
    Left = [int]$m.Groups[5].Value
    Top = [int]$m.Groups[6].Value
    Width = [int]$m.Groups[7].Value
    Height = [int]$m.Groups[8].Value
  }
}

function Get-TargetWindow {
  $t = $Title
  $p = $ProcessName
  if ([string]::IsNullOrWhiteSpace($t) -and [string]::IsNullOrWhiteSpace($p)) {
    $t = '微信'
    $p = 'Weixin,WeChatAppEx'
  }
  $line = [Cua]::FindMain($t, $p)
  if ([string]::IsNullOrWhiteSpace($line)) { throw "window not found title=$t process=$p" }
  return Parse-WinLine $line
}

function Capture-DesktopBitmap([int]$left, [int]$top, [int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  return $bmp
}

function Capture-TargetWindow($win) {
  [void][Cua]::ShowNoActivate($win.Hwnd)
  $printed = $false
  try {
    $bmp = [Cua]::PrintCapture($win.Hwnd, $win.Width, $win.Height)
    $printed = $true
    if (-not [Cua]::MostlyBlank($bmp)) { return $bmp }
    $bmp.Dispose()
  } catch {
    if ($printed) { }
  }
  return Capture-DesktopBitmap $win.Left $win.Top $win.Width $win.Height
}

# WeChat 4 layout is anchored, not proportional: a 72px nav rail and a session
# list ending at x=383 are FIXED; only the right pane stretches with the
# window. Regions are therefore absolute pixel rects (x, y, w, h) so any
# user-chosen window size works. Verified at 1031x723 and 1600x900.
function Get-RegionRect([string]$name, [int]$W, [int]$H) {
  switch ($name.ToLowerInvariant()) {
    'nav' { return @(0, 0, 72, $H) }
    'session' { return @(72, 80, 311, ($H - 80)) }
    'friends' { return @(72, 80, 311, ($H - 80)) }
    'chat' { return @(383, 72, ($W - 383), ($H - 160 - 72)) }
    'composer' { return @(383, ($H - 160), ($W - 383), 160) }
    'rightpane' { return @(383, 0, ($W - 383), $H) }
    'chattitle' { return @(383, 0, 440, 88) }
    default { return @(0, 0, $W, $H) }
  }
}

# --- blue AI cursor overlay (optional, best-effort) ---
$OverlayDir = Join-Path $env:TEMP 'cua'
$OverlayState = Join-Path $OverlayDir 'overlay.json'
$OverlayStop = Join-Path $OverlayDir 'overlay.stop'
$OverlayPid = Join-Path $OverlayDir 'overlay.pid'

function Test-OverlayRunning {
  if (-not (Test-Path $OverlayPid)) { return $false }
  try {
    $procId = [int](Get-Content $OverlayPid -Raw)
    return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
  } catch { return $false }
}

function Write-OverlayState([int]$absX, [int]$absY, [string]$action, [bool]$visible) {
  if (-not (Test-OverlayRunning)) { return }
  try {
    New-Item -ItemType Directory -Force -Path $OverlayDir | Out-Null
    $seq = 0; $lx = $absX; $ly = $absY; $la = $action
    if (Test-Path $OverlayState) {
      try {
        $prev = Get-Content $OverlayState -Raw | ConvertFrom-Json
        $seq = [int]$prev.seq
        if ($absX -eq [int]::MinValue) { $lx = [int]$prev.x; $ly = [int]$prev.y }
      } catch { }
    }
    $obj = [ordered]@{ x = $lx; y = $ly; action = $la; seq = ($seq + 1); visible = $visible; ts = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }
    $json = $obj | ConvertTo-Json -Compress
    $tmp = "$OverlayState.tmp"
    [System.IO.File]::WriteAllText($tmp, $json)
    Move-Item -Force $tmp $OverlayState
  } catch { }
}

function Set-OverlayVisible([bool]$visible) {
  if (-not (Test-OverlayRunning)) { return }
  if (-not (Test-Path $OverlayState)) { return }
  try {
    $prev = Get-Content $OverlayState -Raw | ConvertFrom-Json
    $obj = [ordered]@{ x = [int]$prev.x; y = [int]$prev.y; action = [string]$prev.action; seq = [int]$prev.seq; visible = $visible; ts = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }
    $json = $obj | ConvertTo-Json -Compress
    $tmp = "$OverlayState.tmp"
    [System.IO.File]::WriteAllText($tmp, $json)
    Move-Item -Force $tmp $OverlayState
  } catch { }
}

# mark an action event at agent (screenshot-space) coords; converts to absolute
function Signal-Overlay([int]$x, [int]$y, [string]$action) {
  if ($x -eq [int]::MinValue -or $y -eq [int]::MinValue) {
    $p = [Cua]::Pos(); Write-OverlayState $p.X $p.Y $action $true
  } else {
    $a = Get-AbsPoint $x $y; Write-OverlayState $a.X $a.Y $action $true
  }
}

# One dispatch used by both single-shot CLI mode and the resident server mode
# (server mode saves the ~0.7-1s PowerShell+.NET startup on EVERY action).
# PowerShell's dynamic scoping lets helpers like Get-TargetWindow read the
# locals ($Title, $Region, ...) set here.
# NOTE: $A is intentionally UNTYPED. A [hashtable]-typed parameter here makes
# PowerShell spuriously try to coerce the return of any helper called inside
# (e.g. Get-AbsPoint's pscustomobject) back into [hashtable] and throw. Leaving
# it untyped sidesteps that binder quirk; callers always pass a hashtable.
function Invoke-CuaCommand($A) {
  $Command = [string]$A.Command
  $X = [int]$A.X; $Y = [int]$A.Y
  $Button = [string]$A.Button; $Count = [int]$A.Count
  $Key = [string]$A.Key; $Duration = [int]$A.Duration
  $Text = [string]$A.Text
  $Direction = [string]$A.Direction; $Pixels = [int]$A.Pixels
  $Path = [string]$A.Path; $DragPath = [string]$A.DragPath
  $Title = [string]$A.Title; $ProcessName = [string]$A.ProcessName
  $Region = [string]$A.Region; $HashSize = [int]$A.HashSize
  $Width = [int]$A.Width; $Height = [int]$A.Height
  $Raw = [bool]$A.Raw

  switch ($Command) {
  'size' {
    Write-Output "size ${vw}x${vh} origin ${vx},${vy}"
  }
  'pos' {
    $p = [Cua]::Pos()
    Write-Output ("pos {0},{1} (screenshot {2},{3})" -f $p.X, $p.Y, ($p.X - $vx), ($p.Y - $vy))
  }
  'screenshot' {
    if ([string]::IsNullOrWhiteSpace($Path)) {
      $dir = Join-Path $env:TEMP 'cua'
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $Path = Join-Path $dir ("shot-{0}.png" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    } else {
      $pdir = Split-Path -Parent $Path
      if ($pdir -and -not (Test-Path $pdir)) { New-Item -ItemType Directory -Force -Path $pdir | Out-Null }
    }
    $hid = $false
    if (-not $Raw -and (Test-OverlayRunning)) { Set-OverlayVisible $false; Start-Sleep -Milliseconds 70; $hid = $true }
    try {
      $cropWin = -not [string]::IsNullOrWhiteSpace($Title) -or -not [string]::IsNullOrWhiteSpace($ProcessName)
      if ($cropWin) {
        $win = Get-TargetWindow
        $bmp = Capture-TargetWindow $win
        $regionTag = ''
        $rr = $Region.Trim().ToLowerInvariant()
        if ($rr -and $rr -ne 'all' -and $rr -ne 'full') {
          $f = Get-RegionRect $rr $bmp.Width $bmp.Height
          $crop = [Cua]::CropRect($bmp, $f[0], $f[1], $f[2], $f[3])
          $bmp.Dispose()
          $bmp = $crop
          $regionTag = (" region={0}" -f $rr)
        }
        $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $w = $bmp.Width; $h = $bmp.Height
        $bmp.Dispose()
        Write-Output ("screenshot {0} {1}x{2} origin {3},{4} hwnd={5} title={6}{7}" -f $Path, $w, $h, $win.Left, $win.Top, $win.Hwnd, $win.Title, $regionTag)
      } else {
        $bmp = New-Object System.Drawing.Bitmap($vw, $vh)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($vx, $vy, 0, 0, (New-Object System.Drawing.Size($vw, $vh)))
        $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Output ("screenshot {0} {1}x{2} origin {3},{4}" -f $Path, $vw, $vh, $vx, $vy)
      }
    } finally {
      if ($hid) { Set-OverlayVisible $true }
    }
  }
  'find-window' {
    $win = Get-TargetWindow
    Write-Output ("window hwnd={0} title={1} process={2} pid={3} left={4} top={5} width={6} height={7}" -f $win.Hwnd, $win.Title, $win.Process, $win.Pid, $win.Left, $win.Top, $win.Width, $win.Height)
  }
  'focus-window' {
    $win = Get-TargetWindow
    [void][Cua]::FocusWindow($win.Hwnd)
    Start-Sleep -Milliseconds 120
    Write-Output ("focused hwnd={0} title={1}" -f $win.Hwnd, $win.Title)
  }
  'resize-window' {
    if ($Width -lt 1 -or $Height -lt 1) { throw 'resize-window requires -Width and -Height' }
    $win = Get-TargetWindow
    [void][Cua]::ResizeWindow($win.Hwnd, $Width, $Height)
    Start-Sleep -Milliseconds 180
    $win2 = Get-TargetWindow
    Write-Output ("window hwnd={0} title={1} process={2} pid={3} left={4} top={5} width={6} height={7}" -f $win2.Hwnd, $win2.Title, $win2.Process, $win2.Pid, $win2.Left, $win2.Top, $win2.Width, $win2.Height)
  }
  'hittest' {
    if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { throw 'hittest requires -X and -Y' }
    $a = Get-AbsPoint $X $Y
    $h = [Cua]::RootWindowAt($a.X, $a.Y)
    Write-Output ("hittest hwnd={0}" -f $h)
  }
  'list-windows' {
    $t = $Title; $p = $ProcessName
    if ([string]::IsNullOrWhiteSpace($t) -and [string]::IsNullOrWhiteSpace($p)) {
      $t = '微信'; $p = 'Weixin,WeChatAppEx'
    }
    $dump = [Cua]::ListWindows($t, $p)
    if ([string]::IsNullOrWhiteSpace($dump)) { Write-Output 'windows 0'; break }
    Write-Output $dump
  }
  'framehash' {
    $win = Get-TargetWindow
    $hid = $false
    if (-not $Raw -and (Test-OverlayRunning)) { Set-OverlayVisible $false; Start-Sleep -Milliseconds 50; $hid = $true }
    try {
      $bmp = Capture-TargetWindow $win
      $sz = [Math]::Max(8, [Math]::Min(32, $HashSize))
      $parts = @(
        ("hwnd={0}" -f $win.Hwnd),
        ("title={0}" -f $win.Title),
        ("process={0}" -f $win.Process),
        ("pid={0}" -f $win.Pid),
        ("rect={0},{1},{2},{3}" -f $win.Left, $win.Top, $win.Width, $win.Height),
        ("size={0}x{1}" -f $win.Width, $win.Height),
        ("hashSize={0}" -f $sz)
      )
      $wanted = @()
      $r = $Region.Trim().ToLowerInvariant()
      if ($r -eq 'all' -or [string]::IsNullOrWhiteSpace($r)) {
        $wanted = @('full', 'nav', 'session', 'chat', 'composer')
      } elseif ($r.Contains(',')) {
        $nums = @($r.Split(',') | ForEach-Object { [double]$_.Trim() })
        if ($nums.Count -ne 4) { throw "Region x,y,w,h needs 4 numbers" }
        $crop = [Cua]::CropFrac($bmp, $nums[0], $nums[1], $nums[2], $nums[3])
        $hsh = [Cua]::AverageHash($crop, $sz)
        $crop.Dispose()
        $parts += ("custom={0}" -f $hsh)
        $wanted = @()
      } else {
        $wanted = @($r)
      }
      foreach ($name in $wanted) {
        if ($name -eq 'full') {
          $hsh = [Cua]::AverageHash($bmp, $sz)
        } else {
          $f = Get-RegionRect $name $bmp.Width $bmp.Height
          $crop = [Cua]::CropRect($bmp, $f[0], $f[1], $f[2], $f[3])
          $hsh = [Cua]::AverageHash($crop, $sz)
          $crop.Dispose()
        }
        $parts += ("{0}={1}" -f $name, $hsh)
      }
      if ($wanted -contains 'session') {
        $ys = [Cua]::ScanBadges($bmp)
        $parts += ("badges={0}" -f $(if ([string]::IsNullOrEmpty($ys)) { 'none' } else { $ys }))
      }
      if ($wanted -contains 'nav' -or $wanted -contains 'full') {
        $parts += ("navbadge={0}" -f [Cua]::ScanNavBadge($bmp))
      }
      $bmp.Dispose()
      Write-Output ("framehash {0}" -f ($parts -join ' '))
    } finally {
      if ($hid) { Set-OverlayVisible $true }
    }
  }
  'move' {
    if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { throw 'move requires -X and -Y' }
    $a = Get-AbsPoint $X $Y
    Signal-Overlay $X $Y 'move'
    [Cua]::Move($a.X, $a.Y)
    Write-Output ("moved {0},{1}" -f $X, $Y)
  }
  'click' {
    if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { throw 'click requires -X and -Y' }
    $a = Get-AbsPoint $X $Y
    $hold = (-not [string]::IsNullOrWhiteSpace($Key))
    Signal-Overlay $X $Y 'click'
    if ($hold) { [Cua]::HoldPress($Key.Split('+')) }
    try {
      [Cua]::Click($a.X, $a.Y, $Button.ToLowerInvariant(), [Math]::Max(1, $Count), $Duration)
    } finally {
      if ($hold) { [Cua]::HoldRelease($Key.Split('+')) }
    }
    Write-Output ("clicked {0},{1} button={2} count={3}{4}" -f $X, $Y, $Button, ([Math]::Max(1, $Count)), $(if ($hold) { " key=$Key" } else { "" }))
  }
  'type' {
    Signal-Overlay ([int]::MinValue) ([int]::MinValue) 'type'
    [Cua]::TypeText($Text)
    Write-Output ("typed {0} chars" -f $Text.Length)
  }
  'paste' {
    # Reliable text entry for Qt apps (WeChat drops chars after fullwidth punctuation
    # when injected per-key). Backs up and restores the user's clipboard text.
    if ([string]::IsNullOrEmpty($Text)) { throw 'paste requires -Text' }
    Add-Type -AssemblyName System.Windows.Forms
    $old = $null
    try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $old = [System.Windows.Forms.Clipboard]::GetText() } } catch { }
    [System.Windows.Forms.Clipboard]::SetText($Text)
    Start-Sleep -Milliseconds 120
    Signal-Overlay ([int]::MinValue) ([int]::MinValue) 'type'
    [Cua]::Chord(@('Ctrl', 'v'), 0)
    Start-Sleep -Milliseconds 350
    if ($null -ne $old -and $old.Length -gt 0) {
      try { [System.Windows.Forms.Clipboard]::SetText($old) } catch { }
    }
    Write-Output ("pasted {0} chars" -f $Text.Length)
  }
  'key' {
    if ([string]::IsNullOrWhiteSpace($Key)) { throw 'key requires -Key' }
    Signal-Overlay ([int]::MinValue) ([int]::MinValue) 'key'
    $parts = $Key.Split('+')
    [Cua]::Chord($parts, $Duration)
    Write-Output ("key {0}" -f $Key)
  }
  'scroll' {
    $hasXY = ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue)
    $n = [Math]::Max(1, $Count)
    for ($i = 0; $i -lt $n; $i++) {
      # some apps clamp one wheel EVENT to a fixed distance no matter the
      # delta; -Count sends several events in one invocation
      if ($hasXY) { $a = Get-AbsPoint $X $Y; if ($i -eq 0) { Signal-Overlay $X $Y 'scroll' }; [Cua]::Scroll($Direction.ToLowerInvariant(), $Pixels, $true, $a.X, $a.Y) }
      else { if ($i -eq 0) { Signal-Overlay ([int]::MinValue) ([int]::MinValue) 'scroll' }; [Cua]::Scroll($Direction.ToLowerInvariant(), $Pixels, $false, 0, 0) }
      if ($i -lt $n - 1) { Start-Sleep -Milliseconds 45 }
    }
    Write-Output ("scrolled {0} {1}px x{2}" -f $Direction, $Pixels, $n)
  }
  'drag' {
    if ([string]::IsNullOrWhiteSpace($DragPath)) { throw 'drag requires -DragPath "x1,y1 x2,y2 ..."' }
    $pts = @()
    $firstXY = $null
    foreach ($tok in ($DragPath -split '\s+')) {
      if ([string]::IsNullOrWhiteSpace($tok)) { continue }
      $xy = $tok.Split(',')
      if ($null -eq $firstXY) { $firstXY = @([int]$xy[0], [int]$xy[1]) }
      $a = Get-AbsPoint ([int]$xy[0]) ([int]$xy[1])
      $p = New-Object Cua+POINT
      $p.X = $a.X; $p.Y = $a.Y
      $pts += $p
    }
    if ($firstXY) { Signal-Overlay $firstXY[0] $firstXY[1] 'drag' }
    [Cua]::Drag($pts, 40)
    Write-Output ("dragged {0} points" -f $pts.Count)
  }
  'overlay-start' {
    New-Item -ItemType Directory -Force -Path $OverlayDir | Out-Null
    if (Test-OverlayRunning) { Write-Output 'overlay already running'; break }
    if (Test-Path $OverlayStop) { Remove-Item $OverlayStop -Force -ErrorAction SilentlyContinue }
    $overlayScript = Join-Path $PSScriptRoot 'overlay.ps1'
    if (-not (Test-Path $overlayScript)) { throw "overlay.ps1 not found at $overlayScript" }
    $p = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $overlayScript)
    Set-Content -Path $OverlayPid -Value $p.Id
    Write-Output ("overlay started pid {0}" -f $p.Id)
  }
  'overlay-stop' {
    if (-not (Test-Path $OverlayPid) -and -not (Test-OverlayRunning)) { Write-Output 'overlay not running'; break }
    New-Item -ItemType Directory -Force -Path $OverlayDir | Out-Null
    Set-Content -Path $OverlayStop -Value '1'
    $deadline = (Get-Date).AddMilliseconds(1500)
    while ((Get-Date) -lt $deadline -and (Test-OverlayRunning)) { Start-Sleep -Milliseconds 100 }
    if (Test-OverlayRunning) {
      try { $procId = [int](Get-Content $OverlayPid -Raw); Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch { }
    }
    Remove-Item $OverlayPid, $OverlayState, $OverlayStop -Force -ErrorAction SilentlyContinue
    Write-Output 'overlay stopped'
  }
  }
}

# --- resident server mode: one line in (a command), lines out, '##end <code>' ---

function Parse-CuaLine([string]$s) {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($m in [regex]::Matches($s, '"([^"]*)"|(\S+)')) {
    if ($m.Groups[1].Success) { [void]$out.Add($m.Groups[1].Value) }
    else { [void]$out.Add($m.Groups[2].Value) }
  }
  return $out
}

function Build-CuaArgs($tokens) {
  # PowerShell unrolls a 1-element list return into a scalar string, so a
  # single-token command ("size") would arrive as the string "size" and
  # $tokens[0] would index its first CHARACTER ("s"). Force an array.
  $tokens = @($tokens)
  $A = @{
    Command = ''; X = [int]::MinValue; Y = [int]::MinValue; Button = 'left'; Count = 1
    Key = ''; Duration = 0; Text = ''; Direction = 'down'; Pixels = 300
    Path = ''; DragPath = ''; Title = ''; ProcessName = ''; Region = 'all'
    HashSize = 16; Width = 0; Height = 0; Raw = $false
  }
  if ($tokens.Count -lt 1) { throw 'empty command' }
  $A.Command = [string]$tokens[0]
  if ($A.Command -eq 'server') { throw 'cannot nest server mode' }
  $i = 1
  while ($i -lt $tokens.Count) {
    $t = [string]$tokens[$i]
    if ($t -eq '-Raw') { $A.Raw = $true; $i += 1 }
    else {
      if ($i + 1 -ge $tokens.Count) { throw "missing value for $t" }
      $v = [string]$tokens[$i + 1]
      switch ($t) {
        '-X' { $A.X = [int]$v }
        '-Y' { $A.Y = [int]$v }
        '-Button' { $A.Button = $v }
        '-Count' { $A.Count = [int]$v }
        '-Key' { $A.Key = $v }
        '-Duration' { $A.Duration = [int]$v }
        '-Text' { $A.Text = $v }
        '-TextB64' { $A.Text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) }
        '-Direction' { $A.Direction = $v }
        '-Pixels' { $A.Pixels = [int]$v }
        '-Path' { $A.Path = $v }
        '-DragPath' { $A.DragPath = $v }
        '-Title' { $A.Title = $v }
        '-ProcessName' { $A.ProcessName = $v }
        '-Region' { $A.Region = $v }
        '-HashSize' { $A.HashSize = [int]$v }
        '-Width' { $A.Width = [int]$v }
        '-Height' { $A.Height = [int]$v }
        default { throw "unknown arg $t" }
      }
      $i += 2
    }
  }
  return $A
}

if ($Command -eq 'server') {
  try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
  [Console]::Out.WriteLine('##ready')
  [Console]::Out.Flush()
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if (-not $line) { continue }
    if ($line -eq '__EXIT__') { break }
    try {
      $A = Build-CuaArgs (Parse-CuaLine $line)
      $res = Invoke-CuaCommand $A
      foreach ($o in @($res)) { if ($null -ne $o) { [Console]::Out.WriteLine([string]$o) } }
      [Console]::Out.WriteLine('##end 0')
    } catch {
      [Console]::Out.WriteLine('##err ' + ($_.Exception.Message -replace "[`r`n]+", ' '))
      [Console]::Out.WriteLine('##end 1')
    }
    [Console]::Out.Flush()
  }
} else {
  Invoke-CuaCommand @{
    Command = $Command; X = $X; Y = $Y; Button = $Button; Count = $Count
    Key = $Key; Duration = $Duration; Text = $Text; Direction = $Direction; Pixels = $Pixels
    Path = $Path; DragPath = $DragPath; Title = $Title; ProcessName = $ProcessName
    Region = $Region; HashSize = $HashSize; Width = $Width; Height = $Height; Raw = [bool]$Raw
  }
}
