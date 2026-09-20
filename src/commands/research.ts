import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { AgentSession } from '../agent/session.js';
import { fetchedSourceCount, resetFetchedSources } from '../tools/web.js';

/**
 * BUILD mode output schema:
 * The report is a markdown specification document with these sections:
 * - Executive Summary + design direction
 * - Scope Rules: BUILD list (required pages/features) and DO NOT BUILD
 *   list (literal builder rules with no ambiguity)
 * - Design System: hex colours (+dark), font stack, type scale, spacing
 *   grid, component tokens, breakpoints, motion, WCAG 2.2 AA compliance
 *   (computed contrast ratios for each pair)
 * - Sitemap & User Flow: routes and the flow diagram showing where the
 *   intentional cuts are
 * - Page Specifications: every page with section order, content, components
 *   with states, mobile reflow, and per-page exclusions
 * - Evidence: patterns seen on fetched sites, with confidence
 * - Accessibility & SEO: WCAG details, contrast verification, meta/heading rules
 * - Sources: every fetched URL with credibility AND relevance scores
 *
 * An AI builder consuming this report should be able to write working code
 * without ambiguity.
 */

const REPORT_FILE = 'research-report.md';
/** The reviewer docked us for "just three successfully fetched URLs". */
const SOURCE_FLOOR = 10;

/**
 * Forwarded phase output is capped. Passing every prior phase in full is what
 * overflowed the DeepSeek composer and killed the run at phase 6 - the depth
 * comes from the number of passes, not from re-sending every word.
 */
function carry(text: string, max = 2500): string {
  return text.length > max ? text.slice(0, max) + '\n[...truncated]' : text;
}

function banner(n: number, label: string): void {
  console.log('\n' + '='.repeat(80));
  console.log(`PHASE ${n}/10: ${label}`);
  console.log('='.repeat(80));
}

/**
 * Phase results come back through the finish tool and are NOT rendered by
 * the normal reply path (fenced blocks are stripped from display) - print
 * them here so no phase ever looks empty.
 */
function show(text: string): void {
  const clean = text.trim();
  if (clean) console.log('\n' + clean + '\n');
}

/**
 * Source rules adapt to the query. A GOV.UK page is a primary source for a
 * public-inquiry question and nearly useless for "how should a tech company
 * website look" - phase 1 works out which world this query lives in.
 */
function browseRules(sourceGuide: string): string {
  return `MANDATORY - actually fetch pages. Use web_fetch on real URLs and
run_command with curl for search result pages. A failed fetch (HTTP error /
no text) does NOT count - move to another site. Never list a source you did
not actually fetch.

MATCH SOURCES TO THE QUERY - fetch what answers THIS topic most directly:
${sourceGuide}

SOURCE QUALITY RULES (a report was downgraded for breaking these):
- For build/design/product topics the PRIMARY sources are live product
  sites and official docs (real company homepages, pricing and docs pages,
  design-system documentation, WCAG, MDN, Baymard/NNGroup research).
  Government archives are the WRONG sources for these queries.
- For historical/scientific topics the primary sources are inquiry
  transcripts, official archives, peer-reviewed papers, original documents.
- FETCH PAGES WITH REAL CONTENT, not index/header/landing pages.
- NEVER cite Reddit, Quora, YouTube, personal blogs, or forum threads as
  evidence. They may only point you TO a source you then fetch.
- Wikipedia is a starting map, not a citation - follow its references out.`;
}

type Mode = 'BUILD' | 'INVESTIGATE';

/** Phase 1 declares the mode; fall back to a keyword guess if it forgets. */
function detectMode(profile: string, query: string): Mode {
  const m = profile.match(/MODE:\s*(BUILD|INVESTIGATE)/i);
  if (m) return m[1].toUpperCase() as Mode;
  return /\b(website|web ?site|app|build|design|create|make|ui|ux|landing|store|dashboard)\b/i
    .test(query) ? 'BUILD' : 'INVESTIGATE';
}

/** Pull the MUST INCLUDE / MUST EXCLUDE block so every phase re-reads it. */
function constraintBlock(profile: string): string {
  const m = profile.match(/MUST INCLUDE[\s\S]*?(?=SOURCE GUIDE|Q1:|$)/i);
  return m ? m[0].trim() : '(no explicit constraints found)';
}

export async function runResearch(
  session: AgentSession,
  query: string,
): Promise<string> {
  resetFetchedSources();
  const startTime = Date.now();
  const startStats = { tasks: session.stats.tasks, toolCalls: session.stats.toolCalls };

  banner(1, 'Query profile, constraints and questions');
  const profile = await session.runTask(
    `QUERY PROFILE for: "${query}"\n\n` +
    `Before any research, classify this query. Answer in EXACTLY this format:\n\n` +
    `MODE: BUILD or INVESTIGATE\n` +
    `(BUILD = the user wants something designed/built and needs a buildable\n` +
    ` specification. INVESTIGATE = the user wants a question researched.)\n\n` +
    `MUST INCLUDE:\n- [every feature/element/page the query explicitly asks\n` +
    `  for, one per line - read the query word by word]\n\n` +
    `MUST EXCLUDE:\n- [every feature the query forbids or limits, one per\n` +
    `  line, stated as a rule a builder can follow. Read constraints\n` +
    `  literally: "add cart but not checkout" means a cart page WITH NO\n` +
    `  checkout button and no checkout flow reachable from it; "checkout\n` +
    `  but no multi payment" means the checkout page offers exactly ONE\n` +
    `  payment method with no method selector.]\n\n` +
    `SOURCE GUIDE:\n- [4-6 bullets: the source types that answer THIS query\n` +
    `  best. For a tech-company website that means LIVE product sites\n` +
    `  (stripe.com, vercel.com, linear.app), design-system docs, Baymard/\n` +
    `  NNGroup research, WCAG/MDN - NOT government sites or history archives.\n` +
    `  For a historical question it means inquiry records, archives, papers.]\n\n` +
    `Then: break the topic into 10-12 specific research questions.\n` +
    `For BUILD queries the questions must cover: layout patterns, typography,\n` +
    `exact colour usage on leading sites, page inventory, per-page structure,\n` +
    `user flows, component patterns, mobile behaviour, dark mode,\n` +
    `accessibility, SEO - and every MUST INCLUDE / MUST EXCLUDE item.\n\n` +
    `Format: Q1: [question]`,
  );
  show(profile);

  const mode = detectMode(profile, query);
  const build = mode === 'BUILD';
  const constraints = constraintBlock(profile);
  const BROWSE = browseRules(
    (profile.match(/SOURCE GUIDE:[\s\S]*?(?=Q1:|$)/i)?.[0] ?? 
     '- sources that answer the query most directly').trim(),
  );
  console.log(`  mode: ${mode}`);

  banner(2, 'Systematic source gathering');
  let sources = await session.runTask(
    `SOURCE GATHERING for: "${query}" (mode: ${mode})\n\n` +
    `Your research questions:\n${carry(profile)}\n\n${BROWSE}\n\n` +
    (build
      ? `Fetch the REAL sites this spec should learn from: leading product\n` +
        `homepages, their pricing/docs/about pages, design-system docs,\n` +
        `UX research (Baymard, NNGroup), WCAG. Note what each ACTUALLY does\n` +
        `- colours, layout, nav - not what articles say about it.\n\n`
      : `Search widely: academic/scholar, government archives, official\n` +
        `inquiry records, museums, major news, books, primary documents.\n\n`) +
    `Fetch at least ${SOURCE_FLOOR + 2} content pages. For EACH page fetched:\n` +
    `URL: [exact url]\nTITLE: [title]\nTYPE: [product-site|docs|ux-research|primary|academic|gov|news]`,
  );
  show(sources);

  // Breadth enforcement against REAL successful web_fetch calls this run -
  // the model's prose is not evidence that it fetched anything.
  for (let round = 0; fetchedSourceCount() < SOURCE_FLOOR && round < 2; round++) {
    const have = fetchedSourceCount();
    console.log(`  breadth check: ${have}/${SOURCE_FLOOR} pages actually fetched - going back for more`);
    const more = await session.runTask(
      `NOT ENOUGH SOURCES. Only ${have} pages have actually been fetched ` +
      `successfully; the floor is ${SOURCE_FLOOR}.\n\n${BROWSE}\n\n` +
      `Fetch ${SOURCE_FLOOR - have + 2} MORE content pages on "${query}" from\n` +
      (build
        ? `angles you have not tried: more leading product sites, their inner\n` +
          `pages (pricing, docs, changelog), design-system documentation,\n` +
          `published UX research, accessibility standards.\n`
        : `angles you have not tried: inquiry transcripts, national archives,\n` +
          `university pages, scientific agencies, museum collections,\n` +
          `newspaper archives.\n`) +
      `List each NEW page:\n` +
      `URL: [exact url]\nTITLE: [title]\nTYPE: [product-site|docs|ux-research|primary|academic|gov|news]`,
    );
    show(more);
    sources += '\n' + more;
  }
  console.log(`  breadth check: ${fetchedSourceCount()} pages actually fetched`);

  banner(3, 'Source credibility and relevance scoring');
  const credibility = await session.runTask(
    `CREDIBILITY + RELEVANCE SCORING (mode: ${mode})\n\n` +
    `Sources found:\n${carry(sources, 3500)}\n\n` +
    `Score EACH source on TWO axes:\n` +
    `CREDIBILITY 1-10: 10 = primary/peer-reviewed/official, 9 = major\n` +
    `research orgs and live product sites observed directly, 7-8 =\n` +
    `professional secondary, 5-6 = general, 1-4 = speculation.\n` +
    `RELEVANCE 1-10: how directly it answers THIS query. A government\n` +
    `site can be credible yet IRRELEVANT to a tech-company design spec -\n` +
    `say so and drop it from further use if relevance is under 6.\n\n` +
    `Format: [Source] - Credibility: X/10 - Relevance: X/10 - [why]\n` +
    `End with: sources KEPT for the report vs DROPPED (and why).`,
  );
  show(credibility);

  banner(4, build ? 'Pattern extraction from real sites' : 'Fact extraction with quotes');
  const facts = await session.runTask(
    (build
      ? `PATTERN EXTRACTION - what the leading sites ACTUALLY do\n\n` +
        `Kept sources:\n${carry(credibility, 3500)}\n\n` +
        `Only report what you directly observed on pages you fetched.\n` +
        `For EACH pattern:\nPATTERN: [e.g. "dark hero with single accent colour"]\n` +
        `SEEN ON: [which sites, which pages]\n` +
        `DETAILS: [specifics: hex values if visible, layout, nav depth,\n` +
        `  typography, section order]\n` +
        `CONTRADICTED BY: [sites that do it differently]\n` +
        `CONFIDENCE: X% - [reasoning]\n\n` +
        `Cover at minimum: colour schemes on real 2026 tech sites (report\n` +
        `what Stripe/Vercel/Linear actually use - if it is dark/near-black\n` +
        `with accents rather than blue, SAY SO and do not let one old A/B\n` +
        `article override direct observation), page inventory, nav patterns,\n` +
        `hero structure, typography scale, spacing, footer content.\n` +
        `Extract 12-15 patterns.`
      : `FACT EXTRACTION - quality over quantity\n\n` +
        `Scored sources:\n${carry(credibility, 3500)}\n\n` +
        `Only extract from sources you ACTUALLY fetched and can quote.\n` +
        `Where a source quotes testimony or a document, cite it precisely.\n\n` +
        `For EACH fact:\nCLAIM: [assertion]\nSOURCE: [name + credibility]\n` +
        `QUOTE: "[exact words from the page, not a paraphrase]"\n` +
        `SUPPORTED BY: [which other sources confirm it]\n` +
        `CONTRADICTED BY: [which sources dispute it]\n` +
        `CONFIDENCE: X% - [reasoning behind that number]\n\n` +
        `Report honestly: sources attempted, fetched, actually used.\n` +
        `Extract 12-15 facts. Do not count a source you could not open.`),
  );
  show(facts);

  banner(5, build ? 'Design decisions weighed' : 'Counterfactual analysis');
  const counterfactuals = await session.runTask(
    (build
      ? `DESIGN DECISION ANALYSIS for: "${query}"\n\n` +
        `Observed patterns:\n${carry(facts, 3500)}\n\n` +
        `Weigh the 4-6 decisions that most shape whether the result feels\n` +
        `10/10 or generic. For EACH:\n\n` +
        `DECISION: [e.g. colour direction, nav pattern, hero style]\n` +
        `OPTION A vs OPTION B: [the real alternatives]\n` +
        `EVIDENCE FOR EACH: [which observed sites/research back each side]\n` +
        `VERDICT PRIORITY (resolve by this order, stop at first match):\n` +
        `  1. What you directly observed on 3+ fetched sites (live evidence)\n` +
        `  2. Peer-reviewed UX research (Baymard, NN Group)\n` +
        `  3. Design-system docs and accessibility standards\n` +
        `  4. Marketing claims and A/B test articles (lowest weight)\n` +
        `Pick one option, X% confidence, and state the priority chain you used.\n\n` +
        `Explicitly resolve any colour contradiction: if Stripe/Vercel/Linear\n` +
        `actually use dark/near-black palettes, that beats any A/B test claim\n` +
        `that blue is "best". Say so directly.`
      : `COUNTERFACTUAL ANALYSIS for: "${query}"\n\n` +
        `Established facts:\n${carry(facts, 3500)}\n\n` +
        `Systematically weigh the "what ifs" - evaluation, not narrative.\n` +
        `Identify the 4-6 decision points or conditions that, if changed,\n` +
        `could have altered the outcome. For EACH:\n\n` +
        `COUNTERFACTUAL: [what could have been different]\n` +
        `MECHANISM: [exactly how it would have changed the outcome]\n` +
        `EVIDENCE FOR: [facts/quotes supporting that it would have worked]\n` +
        `EVIDENCE AGAINST: [facts/quotes suggesting it would not matter]\n` +
        `VERDICT: [would it have changed the outcome? X% + reasoning]\n\n` +
        `Then RANK them: which single change had the highest probability\n` +
        `of altering the outcome, and why.`),
  );
  show(counterfactuals);

  banner(6, build ? 'Page-by-page specification' : 'Active disagreement detection');
  const debates = await session.runTask(
    (build
      ? `PAGE-BY-PAGE SPECIFICATION\n\n` +
        `Decisions made:\n${carry(counterfactuals, 3000)}\n\n` +
        `THE CONSTRAINTS (obey literally):\n${carry(constraints, 1500)}\n\n` +
        `For EVERY page the site needs, write a build spec:\n` +
        `PAGE: [name + route]\nPURPOSE: [one line]\n` +
        `SECTIONS IN ORDER: [hero, features, ... with what content fills each]\n` +
        `KEY COMPONENTS: [cards, forms, tables - with states: empty/loading/error]\n` +
        `MOBILE: [how it reflows]\n` +
        `EXCLUDED HERE: [which MUST-EXCLUDE rules apply to this page,\n` +
        `  e.g. "cart page: NO checkout button, no link into any checkout\n` +
        `  flow" / "checkout page: exactly one payment method, no selector"]\n\n` +
        `Cover every MUST INCLUDE page. End with the full sitemap and the\n` +
        `user flow (land -> browse -> cart | checkout -> confirmation),\n` +
        `showing exactly where the flow is intentionally cut.`
      : `ACTIVE DISAGREEMENT DETECTION\n\n` +
        `Facts so far:\n${carry(facts, 3000)}\n\n` +
        `Do NOT wait for contradictions to surface - go hunting for them.\n` +
        `${BROWSE}\n\n` +
        `Search for known scholarly splits on "${query}": revisionist vs\n` +
        `orthodox readings, competing schools, how the reading changed by\n` +
        `decade.\n\nMANDATORY: find at least 3-5 genuine disagreements.\n\n` +
        `For EACH:\nDEBATE: [what is disputed]\n` +
        `SCHOOL A: [scholars, works] - evidence: [their actual quotes]\n` +
        `SCHOOL B: [scholars, works] - evidence: [their actual quotes]\n` +
        `WHY THEY DIVERGE: [different sources? method? values?]\n` +
        `CURRENT CONSENSUS: [which view leads recent work, X% confidence]`),
  );
  show(debates);

  banner(7, build ? 'Design system specification' : 'Academic synthesis');
  const synthesis = await session.runTask(
    (build
      ? `DESIGN SYSTEM SPECIFICATION - exact values an AI can turn into CSS\n\n` +
        `Page specs:\n${carry(debates, 3000)}\n\n` +
        `Decisions:\n${carry(counterfactuals, 2000)}\n\n` +
        `Produce concrete tokens, grounded in what you observed:\n` +
        `COLOURS: primary, accent, surface, background, text, border,\n` +
        `  success/error - as exact hex values, plus dark-mode variants\n` +
        `TYPOGRAPHY: font stack, base size, full heading scale with sizes,\n` +
        `  weights and line-heights\n` +
        `SPACING: the grid unit (4px/8px) and the scale\n` +
        `COMPONENTS: buttons (default/hover/active/disabled with values),\n` +
        `  inputs (+focus/error states), cards, nav bar, footer\n` +
        `BREAKPOINTS: mobile-first values and what changes at each\n` +
        `MOTION: durations, easing, what animates and what never does\n` +
        `ACCESSIBILITY: WCAG 2.2 AA compliance - compute contrast ratios\n` +
        `  (WCAG Relative Luminance formula) for EVERY text/background pair\n` +
        `  using the exact chosen hex values. Minimum 4.5:1 for normal text,\n` +
        `  3:1 for large text. If any pair falls below AA, revise the palette\n` +
        `  to fix it - do not ship with contrast violations. Also: focus rings\n` +
        `  (min 3px, min 2px outline), touch targets (48px min).\n` +
        `SEO: title/meta pattern, heading hierarchy, structured data.`
      : `SCHOLARLY ARGUMENT SYNTHESIS\n\n` +
        `Disagreements found:\n${carry(debates, 3000)}\n\n` +
        `Counterfactual rankings:\n${carry(counterfactuals, 2000)}\n\n` +
        `Compare ARGUMENTS, not just facts. For each major debate:\n\n` +
        `ARGUMENT A - key scholars, core thesis in 2-3 sentences, the\n` +
        `  primary evidence they cite, who backs them in modern work,\n` +
        `  strength of that evidence\n` +
        `ARGUMENT B - the same treatment for the opposing case\n\n` +
        `COMPARATIVE ANALYSIS: which uses better primary sources, which\n` +
        `  has more recent backing, which accounts for more evidence?\n\n` +
        `CONCLUSION: [X% confidence] - A is stronger because... and what\n` +
        `future work would actually settle it.\n\n` +
        `Write this at graduate-seminar level, not as a summary.`),
  );
  show(synthesis);

  banner(8, build ? 'Constraint audit' : 'Evidence gaps');
  const gaps = await session.runTask(
    (build
      ? `CONSTRAINT AUDIT - check the spec against the query, line by line\n\n` +
        `THE CONSTRAINTS:\n${carry(constraints, 1500)}\n\n` +
        `The spec so far:\n${carry(synthesis, 2500)}\n\n` +
        `For EVERY MUST INCLUDE item: where in the spec is it? Quote it.\n` +
        `For EVERY MUST EXCLUDE item: does the spec state the exclusion as\n` +
        `an explicit builder rule? Quote it.\n` +
        `Then list what is still MISSING for a builder: undefined states,\n` +
        `pages without section specs, tokens without values, missing\n` +
        `mobile/dark-mode/error/SEO coverage.\n` +
        `Format: ITEM -> COVERED (quote) | MISSING (what to add)`
      : `EVIDENCE GAPS\n\nAnalysis so far:\n${carry(synthesis, 3000)}\n\n` +
        `What is MISSING? Be honest and specific:\n` +
        `- claims resting on no primary source\n` +
        `- topics with only secondary coverage\n` +
        `- recent developments not yet reflected\n` +
        `- perspectives absent from the sources you reached\n` +
        `- the evidence that would actually settle the open disputes`),
  );
  show(gaps);

  banner(9, 'Self-challenge');
  const challenge = await session.runTask(
    `SELF-CHALLENGE\n\nYour analysis:\n${carry(synthesis, 3000)}\n\n` +
    (build
      ? `Constraint audit:\n${carry(gaps, 2000)}\n\n` +
        `Now attack your own spec as the harshest reviewer:\n` +
        `- could an AI build the WRONG thing from any ambiguous line?\n` +
        `- is any MUST EXCLUDE still only implied instead of stated as a\n` +
        `  "DO NOT BUILD" rule?\n` +
        `- does any recommendation contradict what the fetched sites\n` +
        `  actually do?\n` +
        `- fill every MISSING item from the audit with a concrete spec NOW.\n\n` +
        `If the honest answer changes the spec, REVISE it explicitly.`
      : `Gaps identified:\n${carry(gaps, 1500)}\n\n` +
        `Now argue against yourself:\n` +
        `- where could this conclusion be wrong?\n` +
        `- what evidence cuts against it?\n` +
        `- which major experts did you miss?\n` +
        `- are you favouring one claim for reasons other than evidence?\n\n` +
        `If the honest answer changes your assessment, REVISE it explicitly.`),
  );
  show(challenge);

  banner(10, 'Writing report to disk');
  await session.runTask(
    `WRITE THE FINAL REPORT with the write_file tool.\n\npath: ${REPORT_FILE}\n\n` +
    `Revisions from self-challenge:\n${carry(challenge, 2000)}\n\n` +
    (build
      ? `THE CONSTRAINTS (every one must appear in the report):\n` +
        `${carry(constraints, 1500)}\n\n` +
        `This is a BUILD SPECIFICATION an AI will follow verbatim. It must\n` +
        `contain, in markdown:\n` +
        `# Build Specification: ${query}\n` +
        `## Executive Summary - the design direction and why, with confidence\n` +
        `## Scope Rules - two explicit lists an AI can obey:\n` +
        `   BUILD: [every required page/feature]\n` +
        `   DO NOT BUILD: [every exclusion as a literal rule, e.g. "cart\n` +
        `   page has NO checkout button", "checkout offers exactly ONE\n` +
        `   payment method - no selector, no wallets, no save-for-later"]\n` +
        `## Design System - exact tokens: hex colours (+dark mode), font\n` +
        `   stack and type scale, spacing grid, button/input states,\n` +
        `   breakpoints, motion rules\n` +
        `## Sitemap & User Flow - every page and route; the flow diagram\n` +
        `   showing exactly where it is intentionally cut\n` +
        `## Page Specifications - EVERY page: sections in order, content of\n` +
        `   each, components with empty/loading/error states, mobile reflow,\n` +
        `   and the exclusions that apply to that page\n` +
        `## Evidence - pattern | seen on (real fetched sites) | confidence;\n` +
        `   resolve the colour question from direct observation\n` +
        `## Accessibility & SEO - WCAG 2.2 AA specifics, contrast ratios,\n` +
        `   meta/heading/structured-data rules\n` +
        `## Limitations - what a builder must still decide\n` +
        `## Sources - every URL actually fetched with credibility AND\n` +
        `   relevance scores; drop irrelevant ones from evidence use.\n`
      : `The file must contain, in markdown:\n` +
        `# Research Report: ${query}\n` +
        `## Executive Summary - findings with confidence and why\n` +
        `## Methodology - questions explored, sources attempted vs used,\n` +
        `   credibility distribution\n` +
        `## Key Findings - each with a direct quote, precise citation and\n` +
        `   confidence %\n` +
        `## Counterfactual Analysis - ranked table: change | mechanism |\n` +
        `   verdict | confidence, then the single most decisive factor\n` +
        `## Scholarly Debates - each school, its evidence, modern backing\n` +
        `## Evidence Matrix - claim | quote | supporting sources | confidence\n` +
        `## Historiographical Evolution - how the reading changed, what is\n` +
        `   settled, what stays live\n` +
        `## Limitations - what is missing and what would change conclusions\n` +
        `## Sources - every URL actually fetched, with credibility scores.\n`) +
    `\nWrite the WHOLE report in ONE write_file call, then finish. Do NOT\n` +
    `put the report in the finish summary - it belongs in the file.`,
  );

  console.log('\n' + '='.repeat(80));
  console.log('RESEARCH COMPLETE');
  console.log('='.repeat(80) + '\n');

  const endTime = Date.now();
  const elapsedSec = Math.round((endTime - startTime) / 1000);
  const tasksDone = session.stats.tasks - startStats.tasks;
  const toolCallsDone = session.stats.toolCalls - startStats.toolCalls;

  try {
    const report = await readFile(join(cwd(), REPORT_FILE), 'utf8');
    console.log(report);
    return `Report saved to ${REPORT_FILE} (${report.split('\n').length} lines, ` +
      `${fetchedSourceCount()} sources, ${tasksDone} tasks, ${toolCallsDone} tool calls, ${elapsedSec}s)`;
  } catch {
    return `Research ran, but ${REPORT_FILE} was never written - re-run to retry phase 10.`;
  }
}