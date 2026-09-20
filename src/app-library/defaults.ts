import type { AppProfile } from './types.js';

const builtin = (p: Omit<AppProfile, 'status' | 'updatedAt'>): AppProfile => ({
  ...p,
  status: 'builtin',
  updatedAt: '2026-09-10',
});

export const DEFAULT_APP_PROFILES: AppProfile[] = [
  builtin({
    id: 'blender', name: 'Blender', description: '3D modeling, animation, materials, viewport and scene workflows.',
    match: { processes: ['blender', 'blender.exe'], windowTitles: ['Blender'], taskKeywords: ['blender', 'blender 3d', '3d modeling', 'mesh', 'viewport', 'blender scene', 'blender material', 'blender render', 'blender animation'] },
    prerequisites: ['Keep the 3D Viewport focused for viewport shortcuts.', 'Confirm Object Mode/Edit Mode before mode-sensitive operations.', 'Use visible Blender UI controls and mouse/keyboard input for normal app control.'],
    shortcuts: {
      'F3': 'Operator search; useful when a command is known but its menu location is not.',
      'Shift+A': 'Add menu in the active editor.',
      'G / R / S': 'Move / rotate / scale the selected object.',
      'X': 'Delete selected object(s). Confirm when Blender asks.',
      'Tab': 'Toggle Object Mode and Edit Mode.',
      'Shift+D': 'Duplicate selected object or geometry.',
      'Ctrl+S': 'Save the current .blend file.',
      'Ctrl+Space': 'Maximize the area under the cursor.'
    },
    regions: ['Top workspace tabs', '3D Viewport', 'Outliner', 'Properties editor on the right', 'Timeline at the bottom'],
    workflows: [
      { name: 'Add primitive', purpose: 'Create basic geometry quickly.', steps: ['Focus the 3D Viewport.', 'Use Shift+A or F3 and choose the required mesh primitive.', 'Apply G/R/S transforms with explicit axes where useful.'], verify: ['Confirm the new object appears in the Outliner and viewport.'], status: 'builtin' },
      { name: 'Repeated parts', purpose: 'Create fins, supports, or other repeated geometry consistently.', steps: ['Create and shape one part.', 'Use Shift+D to duplicate.', 'Use constrained G/R/S transforms or symmetry/mirroring through visible UI.'], verify: ['Confirm repeated parts remain aligned and attached to the intended parent/body.'], status: 'builtin' },
      { name: 'Material and color', purpose: 'Give an object a visible material/color through Blender UI.', steps: ['Select the target object.', 'Open Material Properties or the appropriate visible material UI.', 'Create/select the material and set Base Color.', 'Switch to Material Preview or Rendered view when needed.'], verify: ['Visually confirm the requested color is actually visible on the object.'], status: 'builtin' },
      { name: 'Save scene', purpose: 'Persist a completed Blender scene.', steps: ['Use Ctrl+S for an existing file.', 'For a new file, use Save As through the visible UI and choose the requested path.'], verify: ['Confirm the file name/path in Blender after saving.'], status: 'builtin' }
    ],
    warnings: ['Do not reuse stale viewport coordinates after changing workspace, resolution, or editor layout.', 'Material controls differ between Blender versions and workspaces; re-observe if a known region is not present.'],
    versionHints: ['Blender 4.x and 5.x share many core shortcuts, but visible UI labels and panel layouts can change.']
  }),
  builtin({
    id: 'vscode', name: 'Visual Studio Code', description: 'Code editor, terminal, command palette, files and workbench navigation.',
    match: { processes: ['code', 'code-insiders', 'Code'], windowTitles: ['Visual Studio Code', 'VS Code'], taskKeywords: ['vs code', 'vscode', 'visual studio code', 'editor', 'workspace'] },
    prerequisites: ['Focus the editor or intended workbench region before keyboard shortcuts.'],
    shortcuts: { 'Ctrl+P': 'Quick Open files.', 'Ctrl+Shift+P': 'Command Palette.', 'Ctrl+S': 'Save file.', 'Ctrl+Shift+S': 'Save As.', 'Ctrl+F': 'Find in current editor.', 'Ctrl+Shift+F': 'Search across workspace.', 'Ctrl+`': 'Toggle integrated terminal.', 'Ctrl+B': 'Toggle side bar.' },
    regions: ['Activity Bar', 'Side Bar / Explorer', 'Editor', 'Panel / integrated terminal', 'Status bar'],
    workflows: [
      { name: 'Open file', purpose: 'Navigate directly to a known file.', steps: ['Focus VS Code.', 'Press Ctrl+P.', 'Type the file name/path.', 'Press Enter.'], verify: ['Confirm the requested file is the active editor tab.'], status: 'builtin' },
      { name: 'Command Palette', purpose: 'Use a known VS Code command without menu hunting.', steps: ['Press Ctrl+Shift+P.', 'Type the command name.', 'Select the matching command.'], verify: ['Confirm the command result changed the intended workbench state.'], status: 'builtin' }
    ],
    warnings: ['Workspace trust, extensions, keybindings, and OS-level shortcuts can change behavior.'],
    versionHints: ['Stable and Insiders builds may expose different process names and UI labels.']
  }),
  builtin({
    id: 'notepad', name: 'Notepad', description: 'Windows text editor for fast text entry and file operations.',
    match: { processes: ['notepad', 'Notepad'], windowTitles: ['Notepad'], taskKeywords: ['notepad', 'text editor'] },
    prerequisites: ['Focus the document editor before typing. Prefer UI Automation ValuePattern for large exact text when available.'],
    shortcuts: { 'Ctrl+A': 'Select all document text.', 'Ctrl+S': 'Save.', 'Ctrl+O': 'Open.', 'Ctrl+Z': 'Undo.', 'Ctrl+F': 'Find.' },
    regions: ['Document editor', 'Tab/title area', 'File menu'],
    workflows: [
      { name: 'Replace document text', purpose: 'Set exact text reliably.', steps: ['Focus the document editor.', 'Select all with Ctrl+A.', 'Replace with the requested text using the strongest available editable-control method.'], verify: ['Read back the editor value when UI Automation exposes it.'], status: 'builtin' }
    ],
    warnings: ['Window titles may include the current file name or modified-state marker. Match the process when the title changes.'],
    versionHints: ['Modern Windows Notepad is a Store-style app on many systems.']
  }),
  builtin({
    id: 'chrome', name: 'Google Chrome', description: 'Web browser navigation, tabs, address bar and page interaction.',
    match: { processes: ['chrome'], windowTitles: ['Google Chrome', 'Chrome'], taskKeywords: ['chrome', 'browser', 'web page', 'website'] },
    prerequisites: ['Focus the browser window before browser-level shortcuts.'],
    shortcuts: { 'Ctrl+L': 'Focus address bar.', 'Ctrl+T': 'New tab.', 'Ctrl+W': 'Close current tab.', 'Ctrl+Shift+T': 'Reopen last closed tab.', 'Ctrl+Tab': 'Next tab.', 'Ctrl+Shift+Tab': 'Previous tab.', 'Ctrl+R': 'Reload page.' },
    regions: ['Tabs', 'Address bar', 'Page viewport', 'Bookmarks bar', 'Downloads area'],
    workflows: [
      { name: 'Navigate URL', purpose: 'Open a known URL quickly.', steps: ['Press Ctrl+L.', 'Type the URL.', 'Press Enter.'], verify: ['Confirm the intended page title or URL is visible.'], status: 'builtin' }
    ],
    warnings: ['Web-page controls belong to the page and may require browser DOM tools or visual/semantic inspection rather than browser shortcuts.'],
    versionHints: ['Chrome process names are stable, but window titles are page-dependent.']
  }),
  builtin({
    id: 'edge', name: 'Microsoft Edge', description: 'Web browser navigation, tabs, address bar and page interaction.',
    match: { processes: ['msedge', 'msedge.exe'], windowTitles: ['Microsoft Edge', 'Edge'], taskKeywords: ['edge', 'browser', 'web page', 'website'] },
    prerequisites: ['Focus the Edge window before browser-level shortcuts.'],
    shortcuts: { 'Ctrl+L': 'Focus address bar.', 'Ctrl+T': 'New tab.', 'Ctrl+W': 'Close current tab.', 'Ctrl+Shift+T': 'Reopen last closed tab.', 'Ctrl+Tab': 'Next tab.', 'Ctrl+Shift+Tab': 'Previous tab.', 'Ctrl+R': 'Reload page.' },
    regions: ['Tabs', 'Address bar', 'Page viewport', 'Favorites bar', 'Downloads area'],
    workflows: [
      { name: 'Navigate URL', purpose: 'Open a known URL quickly.', steps: ['Press Ctrl+L.', 'Type the URL.', 'Press Enter.'], verify: ['Confirm the intended page title or URL is visible.'], status: 'builtin' }
    ],
    warnings: ['Web-page controls belong to the page and may require browser DOM tools or visual/semantic inspection rather than browser shortcuts.'],
    versionHints: ['Edge process names can include multiple helper processes; match the main window.']
  }),
  builtin({
    id: 'explorer', name: 'File Explorer', description: 'Windows file browsing, folders, paths and file management UI.',
    match: { processes: ['explorer', 'explorer.exe'], windowTitles: ['File Explorer'], taskKeywords: ['file explorer', 'explorer', 'folder', 'directory', 'files'] },
    prerequisites: ['Confirm the intended Explorer window/path before destructive file actions.'],
    shortcuts: { 'Win+E': 'Open File Explorer.', 'Ctrl+L': 'Focus address/location bar.', 'Alt+Left': 'Back.', 'Alt+Right': 'Forward.', 'Ctrl+Shift+N': 'Create new folder.', 'F2': 'Rename selected item.' },
    regions: ['Navigation pane', 'Address bar', 'File list', 'Details/preview pane', 'Command bar'],
    workflows: [
      { name: 'Open folder path', purpose: 'Navigate directly to a known directory.', steps: ['Focus Explorer.', 'Press Ctrl+L.', 'Type the full path.', 'Press Enter.'], verify: ['Confirm the target folder is displayed.'], status: 'builtin' }
    ],
    warnings: ['Explorer title often changes to the current folder, so process matching is more reliable than exact title matching.'],
    versionHints: ['Windows 11 Explorer command bar differs from older Windows versions.']
  }),
  builtin({
    id: 'terminal', name: 'Windows Terminal', description: 'Windows Terminal tabs, panes and shell sessions.',
    match: { processes: ['WindowsTerminal', 'wt'], windowTitles: ['Windows Terminal'], taskKeywords: ['windows terminal', 'terminal'] },
    prerequisites: ['Focus the intended terminal tab/pane before typing commands.'],
    shortcuts: { 'Ctrl+Shift+T': 'New tab in common Windows Terminal configurations.', 'Ctrl+Shift+W': 'Close current tab/pane in common configurations.', 'Ctrl+Shift+P': 'Command palette.' },
    regions: ['Tab bar', 'Terminal viewport', 'Command input line', 'Pane split regions'],
    workflows: [],
    warnings: ['User keybindings can override defaults; verify before relying on a shortcut that matters.'],
    versionHints: ['Windows Terminal keybindings are configurable.']
  }),
  builtin({
    id: 'powershell', name: 'PowerShell', description: 'Windows PowerShell or PowerShell 7 console.',
    match: { processes: ['powershell', 'pwsh', 'WindowsPowerShell'], windowTitles: ['PowerShell', 'Windows PowerShell'], taskKeywords: ['powershell', 'pwsh', 'powershell console'] },
    prerequisites: ['Treat typed commands as terminal actions subject to the agent safety policy.'],
    shortcuts: { 'Ctrl+C': 'Cancel the current command.', 'Up': 'Previous command.', 'Down': 'Next command.' },
    regions: ['Console input', 'Console output', 'Title bar'],
    workflows: [],
    warnings: ['Never use App Library shortcuts to bypass command safety or confirmation policy.'],
    versionHints: ['Windows PowerShell 5.1 and PowerShell 7 use different process names.']
  }),
  builtin({
    id: 'paint', name: 'Paint', description: 'Windows Paint drawing and image-editing application.',
    match: { processes: ['mspaint', 'Paint'], windowTitles: ['Paint'], taskKeywords: ['paint', 'drawing', 'draw', 'image editing'] },
    prerequisites: ['Focus the canvas or intended toolbar control before mouse/keyboard input.'],
    shortcuts: { 'Ctrl+O': 'Open image.', 'Ctrl+S': 'Save image.', 'Ctrl+Z': 'Undo.', 'Ctrl+Y': 'Redo.' },
    regions: ['Ribbon/toolbar', 'Canvas', 'Color controls', 'Status bar'],
    workflows: [],
    warnings: ['Canvas coordinates are layout-dependent; re-observe after resizing or changing zoom.'],
    versionHints: ['Modern Windows Paint UI differs substantially from classic Paint.']
  }),
  builtin({
    id: 'calculator', name: 'Calculator', description: 'Windows Calculator for visible calculator tasks.',
    match: { processes: ['CalculatorApp', 'calculator'], windowTitles: ['Calculator'], taskKeywords: ['calculator', 'calculate'] },
    prerequisites: ['Confirm the calculator mode and focused input/display.'],
    shortcuts: {},
    regions: ['Mode/navigation area', 'Display', 'Keypad'],
    workflows: [],
    warnings: ['Scientific, programmer, and standard modes expose different controls; inspect mode before complex input.'],
    versionHints: ['Windows Calculator is commonly packaged as a Store app.']
  }),
  builtin({
    id: 'whatsapp', name: 'WhatsApp', description: 'WhatsApp Desktop conversations, search and messaging UI.',
    match: { processes: ['WhatsApp', 'WhatsApp.exe'], windowTitles: ['WhatsApp'], taskKeywords: ['whatsapp', 'message', 'chat', 'send a message'] },
    prerequisites: ['Confirm the correct chat/contact before sending a message.'],
    shortcuts: { 'Ctrl+F': 'Search within the WhatsApp desktop interface in common builds.', 'Ctrl+N': 'New chat in common builds.' },
    regions: ['Chat list', 'Search area', 'Conversation pane', 'Message composer', 'Send button'],
    workflows: [
      { name: 'Find conversation', purpose: 'Locate a known contact or company before messaging.', steps: ['Focus WhatsApp.', 'Use the visible search control or Ctrl+F when supported.', 'Type the exact contact/company name.', 'Select the intended conversation.'], verify: ['Confirm the conversation header matches the intended recipient before typing or sending.'], status: 'builtin' }
    ],
    warnings: ['Recipient verification is mandatory before sending messages; do not infer a recipient from a partial match.'],
    versionHints: ['WhatsApp Store builds may use WebView-based UI and can change accessibility exposure.']
  })
];
