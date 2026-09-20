import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, ROOT_DIR } from '../utils/paths.js';
import { DEFAULT_APP_PROFILES } from './defaults.js';
import type { ActiveWindowLike, AppProfile, AppProfileMatch } from './types.js';

export const APP_LIBRARY_DIR = join(ROOT_DIR, 'app-library');
export const APP_LIBRARY_FILE = join(APP_LIBRARY_DIR, 'profiles.json');

function normalize(value: string | undefined): string { return (value ?? '').toLowerCase().trim(); }
function includesToken(haystack: string, needle: string): boolean {
  const h = normalize(haystack); const n = normalize(needle);
  return !!n && (h === n || h.includes(n));
}

export async function ensureAppLibrary(): Promise<void> {
  await ensureDir(APP_LIBRARY_DIR);
  try { await readFile(APP_LIBRARY_FILE, 'utf8'); return; } catch { /* first run */ }
  await writeFile(APP_LIBRARY_FILE, JSON.stringify(DEFAULT_APP_PROFILES, null, 2) + '\n', 'utf8');
}

export async function loadAppProfiles(): Promise<AppProfile[]> {
  await ensureAppLibrary();
  try {
    const parsed = JSON.parse(await readFile(APP_LIBRARY_FILE, 'utf8')) as unknown;
    if (Array.isArray(parsed)) return parsed as AppProfile[];
  } catch { /* fall back to built-ins */ }
  return DEFAULT_APP_PROFILES;
}

function scoreProfile(profile: AppProfile, task: string, active?: ActiveWindowLike): number {
  const taskText = normalize(task);
  const process = normalize(active?.process);
  const title = normalize(active?.title);
  let score = 0;
  if (process && profile.match.processes.some(p => includesToken(process, p))) score += 100;
  if (title && profile.match.windowTitles.some(t => includesToken(title, t))) score += 70;
  for (const keyword of profile.match.taskKeywords) {
    const k = normalize(keyword);
    if (k && taskText.includes(k)) score += k.includes(' ') ? 35 : 25;
  }
  if (profile.status === 'failed') score -= 120;
  if (profile.status === 'stale') score -= 25;
  return score;
}

function confidenceFor(score: number, profile: AppProfile, active?: ActiveWindowLike): number {
  const process = normalize(active?.process);
  const title = normalize(active?.title);
  const processHit = !!process && profile.match.processes.some(p => includesToken(process, p));
  const titleHit = !!title && profile.match.windowTitles.some(t => includesToken(title, t));
  // An explicit process match is the strongest identity signal.  Task-only
  // matches are useful, but must never look as certain as a live foreground app.
  if (processHit && titleHit) return Math.min(100, score >= 150 ? 99 : 94);
  if (processHit) return Math.min(100, score >= 100 ? 96 : 90);
  if (titleHit) return Math.min(100, score >= 70 ? 88 : 80);
  return Math.min(84, 48 + Math.min(36, Math.max(0, score - 20)));
}

export async function matchAppProfilesDetailed(task: string, active?: ActiveWindowLike): Promise<AppProfileMatch[]> {
  const profiles = await loadAppProfiles();
  return profiles
    .map(profile => {
      const score = scoreProfile(profile, task, active);
      return { profile, score, confidence: confidenceFor(score, profile, active) };
    })
    .filter(x => x.score >= 25)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.profile.name.localeCompare(b.profile.name))
    .slice(0, 3);
}

export async function matchAppProfiles(task: string, active?: ActiveWindowLike): Promise<AppProfile[]> {
  return (await matchAppProfilesDetailed(task, active)).map(x => x.profile);
}

function workflowRelevance(profile: AppProfile, task: string): string[] {
  const text = normalize(task);
  const scored = profile.workflows.map(w => {
    const hay = normalize(`${w.name} ${w.purpose} ${w.steps.join(' ')} ${w.verify.join(' ')}`);
    let score = 0;
    for (const token of text.split(/[^a-z0-9]+/).filter(x => x.length >= 3)) if (hay.includes(token)) score += 1;
    return { w, score };
  });
  const ranked = scored.sort((a, b) => b.score - a.score);
  const useful = ranked.filter(x => x.score > 0).slice(0, 3).map(x => x.w.name);
  return useful.length ? useful : profile.workflows.slice(0, 3).map(w => w.name);
}

export function formatAppLibraryContext(profiles: AppProfile[], active?: ActiveWindowLike, task = ''): string {
  if (!profiles.length) return '';
  const activeLine = active?.process || active?.title
    ? `Active window: process=${active?.process ?? 'unknown'}, title=${active?.title ?? 'unknown'}`
    : 'Active window: unavailable';
  const primary = profiles[0];
  const primaryScore = scoreProfile(primary, task, active);
  const primaryConfidence = confidenceFor(primaryScore, primary, active);
  const relevant = workflowRelevance(primary, task);
  const blocks = profiles.map((p, index) => {
    const shortcuts = Object.entries(p.shortcuts).slice(0, 12).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    const workflows = p.workflows.slice(0, 6).map(w => `- ${w.name} [${w.status}]: ${w.purpose}\n  Steps: ${w.steps.join(' → ')}\n  Verify: ${w.verify.join(' | ')}`).join('\n');
    return `### ${p.name} [${p.status}]${index === 0 ? ' — PRIMARY MATCH' : ''}\n${p.description}\nPrerequisites: ${p.prerequisites.join(' | ')}\nRegions: ${p.regions.join(' | ')}\n${shortcuts ? `Shortcuts:\n${shortcuts}\n` : ''}${workflows ? `Known workflows:\n${workflows}\n` : ''}Warnings: ${p.warnings.join(' | ')}\nVersion hints: ${p.versionHints.join(' | ')}`;
  }).join('\n\n');
  return `## App Library — ACTIVE CONTROL PROFILE
${activeLine}
Primary profile: ${primary.name}
Match confidence: ${primaryConfidence}%
Recommended workflows for this task: ${relevant.join(', ') || 'none'}

MANDATORY APP-LIBRARY BEHAVIOR:
1. The PRIMARY MATCH is the first-choice control plan for this task. Do not ignore it.
2. Start with the listed workflow(s), shortcuts, and UI regions instead of generic filesystem checks, shell probing, or rediscovering the application's basic controls.
3. Treat profile knowledge as verified baseline guidance; re-observe only to ground coordinates/state or when the UI/version differs.
4. Execute multi-step workflow stages in order and verify each meaningful stage in the real application.
5. After a concrete action failure, re-observe and use the profile's fallback guidance before inventing a different strategy.
6. Manual exploration is a fallback, not the default, when a matching profile exists.
7. Never use a profile to bypass safety/confirmation rules.

${blocks}`;
}

export async function getAppProfile(app: string): Promise<AppProfile | undefined> {
  const q = normalize(app);
  return (await loadAppProfiles()).find(p => p.id === q || normalize(p.name) === q || p.match.taskKeywords.some(k => normalize(k) === q));
}

