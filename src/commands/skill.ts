import { readFile, readdir, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cwd } from 'node:process';
import chalk from 'chalk';
import { AgentSession } from '../agent/session.js';

/** Skills are GLOBAL - saved in ~/.freegent/skills so every project can
 * use them. Project-local .freegent/skills still works and wins on clashes. */
const globalSkillsDir = (): string => join(homedir(), '.freegent', 'skills');
const localSkillsDir = (): string => join(cwd(), '.freegent', 'skills');

/** Forwarded phase output is capped - depth comes from passes, not resends. */
function carry(text: string, max = 2500): string {
  return text.length > max ? text.slice(0, max) + '\n[...truncated]' : text;
}

function banner(n: number, total: number, label: string): void {
  console.log('\n' + '='.repeat(80));
  console.log(`SKILL PHASE ${n}/${total}: ${label}`);
  console.log('='.repeat(80));
}

/** Phase results return via the finish tool - print so no phase looks empty. */
function show(text: string): void {
  const clean = text.trim();
  if (clean) console.log('\n' + clean + '\n');
}

/** Read a skill's raw markdown, or null when it does not exist. */
export async function readSkill(name: string): Promise<string | null> {
  for (const dir of [localSkillsDir(), globalSkillsDir()]) {
    try {
      return await readFile(join(dir, `${name}.md`), 'utf8');
    } catch { /* try next dir */ }
  }
  return null;
}

/** Absolute path of a skill file (local shadows global), or null. */
export async function skillFilePath(name: string): Promise<string | null> {
  for (const dir of [localSkillsDir(), globalSkillsDir()]) {
    const p = join(dir, `${name}.md`);
    try {
      await readFile(p, 'utf8');
      return p;
    } catch { /* try next dir */ }
  }
  return null;
}

/** Pull a "KEY: value" field out of a phase-1 planning answer. */
function field(text: string, key: string): string {
  return new RegExp(`^${key}` + '\\s*:\\s*(.+)$', 'mi').exec(text)?.[1]?.trim() ?? '';
}

/** Output mode of a skill: what it PRODUCES when run. */
export type SkillOutput = 'file-report' | 'text' | 'code' | 'mixed';

function parseOutput(v: string): SkillOutput {
  const s = v.toLowerCase();
  if (s.includes('file') || s.includes('report')) return 'file-report';
  if (s.includes('code')) return 'code';
  if (s.includes('mixed')) return 'mixed';
  return 'text';
}

/** Print every skill the user has created, with description + output mode. */
export async function listSkills(): Promise<void> {
  const entries = new Map<string, string>(); // name -> dir (local shadows global)
  for (const dir of [globalSkillsDir(), localSkillsDir()]) {
    try {
      for (const f of (await readdir(dir)).filter((x) => x.endsWith('.md'))) {
        entries.set(f, dir);
      }
    } catch { /* dir absent */ }
  }
  const files = [...entries.keys()];
  if (files.length === 0) {
    console.log(chalk.dim('No skills yet. Create one: /skill <what the expert should do>'));
    return;
  }
  console.log(chalk.bold('\nYour skills:'));
  for (const f of files.sort()) {
    const name = f.replace(/\.md$/, '');
    let desc = '';
    let phases = 0;
    let out = '';
    try {
      const md = await readFile(join(entries.get(f)!, f), 'utf8');
      desc = /^description:\s*(.+)$/m.exec(md)?.[1]?.trim() ?? '';
      out = /^output:\s*(.+)$/m.exec(md)?.[1]?.trim() ?? '';
      phases = (md.match(/^## PHASE \d+/gm) ?? []).length;
    } catch { /* unreadable - still list it */ }
    const p = phases > 0 ? chalk.cyan(` [${phases}-phase${out ? ` · ${out}` : ''}]`) : '';
    console.log(`  ${chalk.blueBright('/' + name)}${p}  ${chalk.dim(desc)}`);
  }
  console.log(chalk.dim('\nRun: /<name> <request> · Refine: /skill update <name> <changes>\n'));
}

/** Split a skill body into its pipeline phases. */
export function parsePhases(md: string): { label: string; body: string }[] {
  const body = md.replace(/^---[\s\S]*?---\s*/, ''); // strip frontmatter
  const parts = body.split(/^## PHASE \d+[:\s-]*/m);
  if (parts.length < 2) return [{ label: 'Expert response', body: body.trim() }];
  return parts.slice(1).map((p) => {
    const nl = p.indexOf('\n');
    return {
      label: (nl === -1 ? p : p.slice(0, nl)).trim() || 'phase',
      body: (nl === -1 ? '' : p.slice(nl + 1)).trim(),
    };
  });
}

/** Output-mode contract injected into every phase of a skill run. */
function outputContract(out: SkillOutput, name: string): string {
  switch (out) {
    case 'file-report':
      return `OUTPUT CONTRACT: this skill delivers a FILE REPORT. Build the ` +
        `report across phases and in the FINAL phase write the complete ` +
        `document to "${name}-report.md" with write_file (one call), then ` +
        `finish with a 2-3 line pointer to the file. Do NOT dump the whole ` +
        `report into finish summaries.`;
    case 'code':
      return `OUTPUT CONTRACT: this skill delivers WORKING CODE. Create real ` +
        `files with write_file, verify them (check/run_command), and keep ` +
        `finish summaries short: what was built, where, how to run it.`;
    case 'mixed':
      return `OUTPUT CONTRACT: this skill delivers BOTH a written report file ` +
        `and real files/code where the skill's phases call for them. Screen ` +
        `output stays concise; heavy content goes into files.`;
    default:
      return `OUTPUT CONTRACT: this skill delivers its answer ON SCREEN. Put ` +
        `the full, well-formatted answer of each phase in the finish summary ` +
        `(plain text/markdown). Do NOT write any files.`;
  }
}

/**
 * RUN a saved skill as a pipeline: each ## PHASE section becomes one agent
 * pass, with the previous phase's output carried forward - like /research.
 * The skill's own "output:" frontmatter decides file/text/code delivery.
 */
export async function runSkillPipeline(
  session: AgentSession,
  name: string,
  request: string,
): Promise<string> {
  const md = await readSkill(name);
  if (md === null) return `No skill named ${name}.`;
  const persona =
    (/^persona:\s*(.+)$/m.exec(md)?.[1] ??
      /^description:\s*(.+)$/m.exec(md)?.[1] ?? `elite ${name} expert`).trim();
  const out = parseOutput(/^output:\s*(.+)$/m.exec(md)?.[1] ?? 'text');
  const phases = parsePhases(md);
  const contract = outputContract(out, name);
  const startTime = Date.now();
  let prev = '';
  for (let i = 0; i < phases.length; i++) {
    const ph = phases[i];
    banner(i + 1, phases.length, ph.label);
    const isLast = i === phases.length - 1;
    const prompt =
      `You are: ${persona}\n` +
      `You operate at top-0.1% professional level - your output must beat ` +
      `other AIs and senior professionals in this field.\n${contract}\n\n` +
      `CLIENT REQUEST: "${request}"\n\n` +
      (prev ? `PREVIOUS PHASE OUTPUT:\n${carry(prev, 3000)}\n\n` : '') +
      `THIS PHASE (${i + 1}/${phases.length} - ${ph.label}` +
      `${isLast ? ' - FINAL' : ''}):\n` +
      ph.body.replace(/\$ARGS/g, request);
    prev = await session.runTask(prompt);
    show(prev);
  }
  const secs = Math.round((Date.now() - startTime) / 1000);
  return `/${name} finished: ${phases.length} phase(s), ${out} output, ${secs}s.`;
}

/**
 * CREATE a skill - dynamic pipeline. NOTHING is hardcoded to 5 phases:
 * the AI decides in the brief how much design work this skill needs
 * (research or not, how many debate rounds, how many phases the finished
 * skill runs, what it outputs), driven by the field AND the user's words.
 */
export async function runSkillCreate(
  session: AgentSession,
  idea: string,
): Promise<string> {
  const startTime = Date.now();

  // ---- Phase A: the brief - the AI's own decisions about this skill ----
  banner(1, 1, 'Design brief - AI decides the plan');
  const brief = await session.runTask(
    `SKILL DESIGN BRIEF. The user wants a new expert skill:\n"${idea}"\n\n` +
    `YOU decide how this skill should be designed and behave. Read the ` +
    `user's words carefully - if they asked for anything specific (output ` +
    `style, number of steps, research), their wish WINS. Otherwise choose ` +
    `what genuinely fits this profession. Answer EXACTLY:\n\n` +
    `NAME: [short kebab-case skill name]\n` +
    `PERSONA: [one line - a named, top-0.1%, $1M/year expert archetype]\n` +
    `DESCRIPTION: [one line - what the skill does for the user]\n` +
    `OUTPUT: [file-report | text | code | mixed] - what the finished skill\n` +
    `  DELIVERS when run. A research/consulting skill suits file-report; a\n` +
    `  quick-answer skill suits text; a builder skill suits code. If the\n` +
    `  user said what they want, obey them.\n` +
    `RESEARCH: [yes | no] - does designing this skill need LIVE web\n` +
    `  research (fresh trends, prices, tools)? yes for fast-moving fields.\n` +
    `DEBATE_ROUNDS: [0-3] - how many self-debate rounds the design needs.\n` +
    `  Simple utility skill: 0-1. High-stakes consulting skill: 2-3.\n` +
    `SKILL_PHASES: [1-7] - how many phases the FINISHED skill runs per\n` +
    `  request. A one-shot answering skill can be 1-2; a deep consulting\n` +
    `  engagement 4-6. Choose for THIS profession, not a fixed number.\n` +
    `REASONING: [3-5 lines - why you chose these numbers and modes]\n` +
    `USER EXTRAS: [everything specific the user demanded, verbatim]`,
  );
  show(brief);

  const skillName =
    (field(brief, 'NAME') || `skill-${Date.now().toString(36)}`)
      .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  const doResearch = /yes/i.test(field(brief, 'RESEARCH'));
  const debateRounds = Math.min(3, Math.max(0, Number(field(brief, 'DEBATE_ROUNDS')) || 0));
  const skillPhases = Math.min(7, Math.max(1, Number(field(brief, 'SKILL_PHASES')) || 3));
  const out = parseOutput(field(brief, 'OUTPUT'));
  const totalSteps = 1 + (doResearch ? 1 : 0) + 1 + debateRounds + 2;
  let step = 1;
  console.log(chalk.cyan(
    `  plan: ${doResearch ? 'online research + ' : ''}design + ` +
    `${debateRounds} debate round(s) -> ${skillPhases}-phase skill, ` +
    `${out} output (${totalSteps} steps total)`,
  ));

  // ---- Phase B (optional): live online research, AI's choice ----
  let research = '';
  if (doResearch) {
    step++;
    banner(step, totalSteps, 'Online research');
    research = await session.runTask(
      `SKILL DESIGN - LIVE RESEARCH.\n\nBrief:\n${carry(brief)}\n\n` +
      `Use web_fetch on REAL authoritative pages (official docs, leading ` +
      `practitioners' sites, current tools/pricing pages) to learn what the ` +
      `top 0.1% in this field do TODAY. A failed fetch does not count - move ` +
      `to another site. Fetch 4-8 pages, then report:\n` +
      `FINDING: [what] - SOURCE: [url actually fetched] - USE: [how the\n` +
      `skill should apply it]\n` +
      `Cover: current best practices, tools in use this year, standards, ` +
      `and anything that would make this skill beat a generic AI answer.`,
    );
    show(research);
  }

  // ---- Phase C: pipeline design ----
  step++;
  banner(step, totalSteps, 'Pipeline architecture');
  let design = await session.runTask(
    `SKILL DESIGN - ARCHITECTURE.\n\nBrief:\n${carry(brief)}\n` +
    (research ? `\nLive research:\n${carry(research, 3000)}\n` : '') +
    `\nDesign EXACTLY ${skillPhases} phase(s) the finished skill runs per ` +
    `client request, tailored to this profession and the ${out} output ` +
    `mode. For each phase:\n` +
    `PHASE N: [label]\nGOAL: [what this pass produces]\n` +
    `INSTRUCTIONS: [exact prompt-style instructions - concrete, elite,\n` +
    ` with the output format the client sees]\n` +
    `Rules: honour every USER EXTRA from the brief. For file-report skills ` +
    `the last phase writes the report file; for code skills phases build ` +
    `and verify real files; for text skills phases answer on screen.`,
  );
  show(design);

  // ---- Phase D (0-3 rounds): the AI debates its own design ----
  for (let round = 1; round <= debateRounds; round++) {
    step++;
    banner(step, totalSteps, `Self-debate round ${round}/${debateRounds}`);
    const debate = await session.runTask(
      `SELF-DEBATE round ${round}/${debateRounds}. Your current design:\n` +
      `${carry(design, 3500)}\n\n` +
      `Argue BOTH sides like two rival experts:\n` +
      `ADVOCATE: why this design is right (3-4 strongest points)\n` +
      `CRITIC: attack it - wrong phase count? weak instructions? does it\n` +
      ` really fit the user's words: "${idea}"? would a rival AI or a real\n` +
      ` pro deliver more? what would embarrass this skill in front of a\n` +
      ` paying client?\n` +
      `VERDICT: what changes (be specific) or "design holds".\n` +
      `Then output the REVISED full design (same PHASE N format, all ` +
      `phases, incorporating every accepted change).`,
    );
    show(debate);
    design = debate; // next round (or the writer) sees the revised design
  }

  // ---- Phase E: write the skill file (global) ----
  await mkdir(globalSkillsDir(), { recursive: true }).catch(() => undefined);
  const skillPath = join(globalSkillsDir(), `${skillName}.md`).replaceAll('\\', '/');
  step++;
  banner(step, totalSteps, 'Write the skill file');
  await session.runTask(
    `SKILL DESIGN - WRITE THE FILE with write_file.\n\n` +
    `path: ${skillPath}\n\n` +
    `Final design:\n${carry(design, 3500)}\n\nBrief:\n${carry(brief, 1500)}\n\n` +
    `EXACT file format (obey literally):\n` +
    `---\n` +
    `name: ${skillName}\n` +
    `description: [one line from DESCRIPTION]\n` +
    `persona: [one line from PERSONA]\n` +
    `output: ${out}\n` +
    `---\n\n` +
    `## PHASE 1: [label]\n[full instructions]\n\n` +
    `(one "## PHASE N:" heading per designed phase - EXACTLY ` +
    `${skillPhases} of them. Write $ARGS wherever the client's request ` +
    `text belongs - at least once across the file. Instructions must ` +
    `force elite output true to the design and the ${out} output mode.)\n\n` +
    `Write the WHOLE file in ONE write_file call, then finish.`,
  );

  // ---- Phase F: audit ----
  step++;
  banner(step, totalSteps, 'Quality audit');
  const audit = await session.runTask(
    `SKILL DESIGN - AUDIT ${skillPath}.\n\n` +
    `Read the file and check as the harshest reviewer:\n` +
    `- frontmatter: name, description, persona, output: ${out}?\n` +
    `- EXACTLY ${skillPhases} "## PHASE N:" section(s), elite instructions?\n` +
    `- $ARGS present? USER EXTRAS honoured:\n${carry(brief, 1200)}\n` +
    `- phases actually produce ${out} delivery?\n` +
    `- would this beat a generic AI and an average professional?\n` +
    `Fix ANY failure with edit_file/write_file NOW, then finish with:\n` +
    `VERDICT: SHIP or FIXED [what you fixed].`,
  );
  show(audit);

  const secs = Math.round((Date.now() - startTime) / 1000);
  const exists = (await readSkill(skillName)) !== null;
  return exists
    ? `Skill /${skillName} created: ${skillPhases} phase(s), ${out} output, ` +
      `${debateRounds} debate round(s)${doResearch ? ', web-researched' : ''} ` +
      `(${secs}s). Try: /${skillName} <your request>`
    : `Pipeline ran but ${skillPath} was not written - re-run /skill.`;
}

/**
 * UPDATE a skill through a 3-phase pipeline: critique the current file,
 * apply the user's requested change, verify nothing elite was lost.
 */
export async function runSkillUpdate(
  session: AgentSession,
  name: string,
  instructions: string,
): Promise<string> {
  const md = await readSkill(name);
  if (md === null) return `No skill named ${name}. /skill to list.`;
  const skillPath = (await skillFilePath(name))!.replaceAll('\\', '/');
  const startTime = Date.now();

  banner(1, 3, 'Read and critique');
  const critique = await session.runTask(
    `SKILL UPDATE - phase 1. Read ${skillPath}.\n\n` +
    `The user wants this change: "${instructions}"\n\n` +
    `Summarize the skill's current phases and output mode, then plan:\n` +
    `WHERE: [which phases/frontmatter the change touches]\n` +
    `PLAN: [exact edits. If the user's change alters what the skill\n` +
    ` DELIVERS, update the "output:" frontmatter too. If it needs more or\n` +
    ` fewer phases, add/remove "## PHASE N:" sections - the count is the\n` +
    ` skill's choice, not fixed]\n` +
    `KEEP: [what must survive: frontmatter keys, $ARGS, elite quality]\n` +
    `ALSO IMPROVE: [any weakness worth fixing in the same pass]`,
  );
  show(critique);

  banner(2, 3, 'Apply the update');
  await session.runTask(
    `SKILL UPDATE - phase 2. Apply the plan to ${skillPath}\n` +
    `with edit_file/write_file.\n\nPlan:\n${carry(critique, 3000)}\n\n` +
    `User's request (priority - do exactly this first):\n"${instructions}"\n\n` +
    `Keep: frontmatter (name, description, persona, output - update values ` +
    `if meaning changed), numbered "## PHASE N:" sections, $ARGS at least ` +
    `once, top-0.1% professional instruction quality throughout.`,
  );

  banner(3, 3, 'Verify');
  const verify = await session.runTask(
    `SKILL UPDATE - phase 3. Re-read ${skillPath} and verify:\n` +
    `- the user's change is REALLY in: "${instructions}"\n` +
    `- frontmatter intact, phases numbered cleanly, $ARGS present\n` +
    `- instructions still elite level\n` +
    `Fix anything broken NOW, then finish with:\n` +
    `VERDICT: UPDATED - [one line: what changed].`,
  );
  show(verify);

  const secs = Math.round((Date.now() - startTime) / 1000);
  return `Skill /${name} updated (3 phases, ${secs}s).`;
}

/** DELETE a skill file (checks local dir first, then global). */
export async function deleteSkill(name: string): Promise<string | null> {
  const p = await skillFilePath(name);
  if (!p) return null;
  const { rm } = await import('node:fs/promises');
  await rm(p);
  return p;
}