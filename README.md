# FreeGent

Autonomous AI coding and Windows computer-control agent, driven by DeepSeek through browser automation (no paid API key required - it drives the actual web chat UI).

```
╭─────────────────────────────────────────────────────────────╮
│  * FreeGent v1.0.0                                          │
│  Free AI coding agent - creative, autonomous, and verified  │
╰─────────────────────────────────────────────────────────────╯
```

[![Watch the demo](https://img.youtube.com/vi/slKqC-YslTc/maxresdefault.jpg)](https://youtu.be/slKqC-YslTc)

*Click to watch the demo on YouTube (made entirely by FreeGent itself, using its own `/brag` skill).*

## What it does

FreeGent runs an agent loop against DeepSeek's web chat (via a persistent Playwright browser profile), giving it tools to read/write files, run terminal commands, browse and test pages, control the Windows desktop (screenshots, clicks, keyboard), and remember facts across sessions - all through natural-language tasks from your terminal.

- **Interactive REPL** or one-shot `-p` mode for scripts/CI
- **Auto-recovering browser session** - a stalled or frozen chat tab reloads itself and resumes instead of dying
- **Persistent, cross-session memory** - project facts, learned strategies, and full chat history
- **Custom skills** - describe an idea once, get a reusable expert workflow available as its own `/<name>` command
- **Custom MCP tool packs** - 10 built-in packs (browser, filesystem, github, sqlite, etc.) plus AI-built custom ones
- **App Library** - learns app-specific workflows for GUI/desktop automation tasks
- **Auto-named chats** - the AI titles a new chat from your first message; `/rename` still overrides anytime
- **Session resume, fork, and compact** - pick up old chats, branch a conversation, or summarize-and-continue when a chat gets long

## Requirements

- Windows, Node.js >= 20
- A DeepSeek account (no API key - it logs into the actual web chat)

## Install

```powershell
npm install
npm run build
npm install -g .
```

This installs the `freegent` command globally, linked to this project folder.

## Getting started

```powershell
freegent init      # sets up ~/.freegent
freegent login      # opens a browser once to log into DeepSeek
freegent            # starts the interactive REPL
```

One-shot mode (no REPL, good for scripts/CI):

```powershell
freegent -p "explain what this repo does"
freegent -p "fix the failing test" --json
```

## Slash commands (inside the REPL)

| Command | What it does |
|---|---|
| `/help` | Show the in-app help |
| `/clear` | Start a brand-new chat (context reset) |
| `/resume [n|name]` | List or reconnect to a saved chat |
| `/rename <name>` | Rename this session |
| `/research <query>` | Deep research pass to gather context |
| `/skill` / `/skill <idea>` | List, or create, a custom expert skill |
| `/skill update <name> <changes>` | Refine an existing skill |
| `/skill delete <name>` | Delete a skill |
| `/mcp` / `/mcp <idea>` | List MCP tool packs, or build a custom one |
| `/mcp enable|disable|delete <name>` | Manage a pack |
| `/image <path>` / `/paste` | Attach an image to your next message |
| `/fork [name]` | Branch the conversation into a new chat |
| `/rewind [n]` | Undo the last n file changes |
| `/shells` | List/kill background shells the agent started |
| `/diff` | Git status + changed files at a glance |
| `/compact` | Summarize this session and continue in a fresh chat |
| `/sessions` | List saved sessions |
| `/stats` | Session statistics |
| `/exit` | Quit |

Custom commands: drop a `.freegent/commands/<name>.md` file in a project and it becomes `/<name>` (supports `$ARGS`).

## Other CLI commands

```powershell
freegent init                 # initialize ~/.freegent
freegent login [--remote]     # log into DeepSeek
freegent logout               # remove the saved session
freegent doctor               # diagnose setup problems
freegent worktree <name>      # create a git worktree for a parallel session
freegent config [key] [value] # show or set config values
```

## Development

```powershell
npm run dev         # run from source (tsx)
npm run typecheck   # tsc --noEmit
npm run lint         # eslint
npm test              # run tests
npm run build        # compile to dist/
```

## Data & config

All persistent state lives under `~/.freegent/`: browser profile/login session, config, memory, saved chat sessions, skills, MCP packs, and the App Library. Per-project durable notes are kept in `<project>/.freegent/FREEGENT.md` (the project also picks up `CLAUDE.md` / `AGENTS.md` if present).

## License

MIT