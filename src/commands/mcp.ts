import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { AgentSession } from '../agent/session.js';
import { DEFAULT_MCPS } from './mcpDefaults.js';

/** MCPs are GLOBAL tool packs in ~/.freegent/mcp - one .md file each.
 * Enabled packs are injected into the agent's system prompt as recipes it
 * executes through its normal tools (run_command, web_fetch, write_file). */
const mcpDir = (): string => join(homedir(), '.freegent', 'mcp');


export interface McpInfo {
  name: string;
  description: string;
  enabled: boolean;
  builtin: boolean;
  tools: number;
}

function meta(md: string): { description: string; enabled: boolean; builtin: boolean } {
  return {
    description: /^description:\s*(.+)$/m.exec(md)?.[1]?.trim() ?? '',
    enabled: !/^enabled:\s*false\s*$/m.test(md), // default ON
    builtin: /^builtin:\s*true\s*$/m.test(md),
  };
}

export async function readMcp(name: string): Promise<string | null> {
  try {
    return await readFile(join(mcpDir(), `${name}.md`), 'utf8');
  } catch {
    return null;
  }
}

/** First run: install any missing default packs (never overwrites edits). */
export async function installDefaultMcps(): Promise<number> {
  await mkdir(mcpDir(), { recursive: true });
  let added = 0;
  for (const [name, body] of Object.entries(DEFAULT_MCPS)) {
    if ((await readMcp(name)) === null) {
      await writeFile(join(mcpDir(), `${name}.md`), body, 'utf8');
      added++;
    }
  }
  return added;
}

export async function listMcps(): Promise<McpInfo[]> {
  await installDefaultMcps();
  const out: McpInfo[] = [];
  for (const f of (await readdir(mcpDir())).filter((x) => x.endsWith('.md')).sort()) {
    const md = await readFile(join(mcpDir(), f), 'utf8').catch(() => '');
    const m = meta(md);
    out.push({
      name: f.replace(/\.md$/, ''),
      description: m.description,
      enabled: m.enabled,
      builtin: m.builtin,
      tools: (md.match(/^## TOOL:/gm) ?? []).length,
    });
  }
  return out;
}

export async function setMcpEnabled(name: string, on: boolean): Promise<boolean> {
  const md = await readMcp(name);
  if (md === null) return false;
  const next = /^enabled:\s*(true|false)\s*$/m.test(md)
    ? md.replace(/^enabled:\s*(true|false)\s*$/m, `enabled: ${on}`)
    : md.replace(/^---\s*$/m, `---\nenabled: ${on}`); // add into frontmatter
  await writeFile(join(mcpDir(), `${name}.md`), next, 'utf8');
  return true;
}

export async function deleteMcp(name: string): Promise<string | null> {
  const p = join(mcpDir(), `${name}.md`);
  if ((await readMcp(name)) === null) return null;
  await rm(p);
  return p;
}

/** Prompt block of every ENABLED pack - injected into the system prompt. */
export async function buildMcpPromptBlock(): Promise<string> {
  let packs: McpInfo[] = [];
  try {
    packs = (await listMcps()).filter((p) => p.enabled);
  } catch {
    return '';
  }
  if (packs.length === 0) return '';
  const parts: string[] = [
    '## MCP tool packs (connected)',
    'Extra capabilities beyond your core tools. Each pack lists TOOL recipes',
    'you execute with run_command / web_fetch / write_file exactly as shown.',
    'Use them whenever they fit the task - they are already installed.',
  ];
  let budget = 9000; // keep the composer safe; packs are trimmed, not dropped
  for (const p of packs) {
    const md = (await readMcp(p.name)) ?? '';
    const body = md.replace(/^---[\s\S]*?---\s*/, '').trim();
    const slice = body.length > 1100 ? body.slice(0, 1100) + '\n[...trimmed]' : body;
    const block = `### ${p.name} - ${p.description}\n${slice}`;
    if (budget - block.length < 0) break;
    budget -= block.length;
    parts.push(block);
  }
  return parts.join('\n\n');
}

function banner(n: number, total: number, label: string): void {
  console.log('\n' + '='.repeat(80));
  console.log(`MCP PHASE ${n}/${total}: ${label}`);
  console.log('='.repeat(80));
}

function show(text: string): void {
  const clean = text.trim();
  if (clean) console.log('\n' + clean + '\n');
}

function carry(text: string, max = 3000): string {
  return text.length > max ? text.slice(0, max) + '\n[...truncated]' : text;
}

export function printMcpList(packs: McpInfo[]): void {
  if (packs.length === 0) {
    console.log(chalk.dim('No MCPs installed.'));
    return;
  }
  console.log(chalk.bold('\nMCP tool packs:'));
  for (const p of packs) {
    const state = p.enabled ? chalk.green('on ') : chalk.red('off');
    const kind = p.builtin ? chalk.dim(' builtin') : chalk.cyan(' custom');
    console.log(
      `  [${state}] ${chalk.blueBright(p.name.padEnd(16))} ` +
      `${chalk.dim(`${p.tools} tool(s)`)}${kind}  ${chalk.dim(p.description)}`,
    );
  }
  console.log(chalk.dim(
    '\n/mcp <idea> build one · /mcp enable|disable <name> · /mcp delete <name>\n',
  ));
}

/**
 * BUILD a custom MCP pack - dynamic pipeline like /skill: the AI decides
 * how many tools the pack needs and whether live research is required,
 * then writes recipes that actually run on this machine.
 */
export async function runMcpCreate(
  session: AgentSession,
  idea: string,
): Promise<string> {
  await mkdir(mcpDir(), { recursive: true });
  const startTime = Date.now();

  banner(1, 1, 'MCP brief - AI decides the plan');
  const brief = await session.runTask(
    `MCP PACK DESIGN BRIEF. The user wants a new tool pack:\n"${idea}"\n\n` +
    `An MCP pack is a markdown file of TOOL recipes the agent executes via ` +
    `run_command / web_fetch / write_file. Decide and answer EXACTLY:\n` +
    `NAME: [short kebab-case pack name]\n` +
    `DESCRIPTION: [one line - what the pack lets the agent do]\n` +
    `TOOLS: [2-8] - how many tool recipes this pack needs\n` +
    `RESEARCH: [yes | no] - must you web_fetch live docs (API endpoints,\n` +
    `  auth headers, CLI flags) to write CORRECT recipes?\n` +
    `REQUIREMENTS: [tokens/CLIs the user must have, e.g. an API key - or "none"]\n` +
    `REASONING: [2-4 lines]\nUSER EXTRAS: [specific user demands, verbatim]`,
  );
  show(brief);
  const name =
    (/^NAME:\s*(\S+)/mi.exec(brief)?.[1] ?? `mcp-${Date.now().toString(36)}`)
      .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  const doResearch = /^RESEARCH:\s*yes/mi.test(brief);
  const total = doResearch ? 4 : 3;
  let step = 1;
  const mcpPath = join(mcpDir(), `${name}.md`).replaceAll(String.fromCharCode(92), '/');

  let research = '';
  if (doResearch) {
    step++;
    banner(step, total, 'Live docs research');
    research = await session.runTask(
      `MCP RESEARCH. Brief:\n${carry(brief)}\n\n` +
      `web_fetch the REAL official docs needed to write recipes that work ` +
      `TODAY: exact endpoints, auth headers, CLI commands, rate limits. A ` +
      `failed fetch does not count. Report:\n` +
      `FACT: [endpoint/flag/header] - SOURCE: [url fetched] - RECIPE USE: [how]`,
    );
    show(research);
  }

  step++;
  banner(step, total, 'Write the MCP pack');
  await session.runTask(
    `WRITE THE MCP PACK with write_file.\n\npath: ${mcpPath}\n\n` +
    `Brief:\n${carry(brief)}\n` +
    (research ? `\nVerified docs:\n${carry(research)}\n` : '') +
    `\nEXACT format:\n---\nname: ${name}\ndescription: [one line]\n` +
    `enabled: true\nbuiltin: false\n---\n\n` +
    `REQUIREMENTS: [what the user needs installed/configured, or "none"]\n\n` +
    `## TOOL: [tool_name]\nUSE: [when the agent should reach for it]\n` +
    `HOW: [the EXACT run_command / web_fetch recipe with placeholders like\n` +
    ` <QUERY> - copy-paste runnable on Windows (bash shell)]\n` +
    `OUTPUT: [what comes back and how to read it]\n\n` +
    `(one "## TOOL:" section per tool from the brief. Recipes must be real ` +
    `and current - no invented endpoints or flags.)\n` +
    `Write the WHOLE file in ONE write_file call, then finish.`,
  );

  step++;
  banner(step, total, 'Verify the recipes');
  const audit = await session.runTask(
    `MCP AUDIT. Read ${mcpPath}. For each TOOL recipe, sanity-test the safe ` +
    `ones with run_command (version checks, --help, harmless GETs). Fix any ` +
    `recipe that fails or looks invented. Then finish with:\n` +
    `VERDICT: SHIP or FIXED [what] - plus any REQUIREMENTS the user must set up.`,
  );
  show(audit);

  const secs = Math.round((Date.now() - startTime) / 1000);
  return (await readMcp(name)) !== null
    ? `MCP /${name} installed and enabled (${secs}s). It is now available to every task.`
    : `Pipeline ran but ${mcpPath} was not written - re-run /mcp.`;
}