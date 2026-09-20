import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_FILE, ensureRoot } from '../utils/paths.js';
import { DEFAULTS } from './defaults.js';

export type LLMProviderKind = 'deepseek';

export interface FreegentConfig {
  /** Active reasoning provider (DeepSeek only). */
  provider: LLMProviderKind;
  /** DeepSeek chat URL. */
  chatUrl: string;
  /** Run the browser headless during agent runs (login is always headed). */
  headless: boolean;
  /** Max autonomous agent iterations before stopping. */
  maxIterations: number;
  /** Milliseconds of silence that marks a response as complete. */
  responseIdleMs: number;
  /** Hard timeout for a single response, in milliseconds. */
  responseTimeoutMs: number;
  /** Ask before running shell commands. */
  confirmCommands: boolean;
  checkpointMaxEntries: number;
}

export const DEFAULT_CONFIG: FreegentConfig = {
  provider: 'deepseek',
  chatUrl: 'https://chat.deepseek.com/',
  headless: true,
  maxIterations: DEFAULTS.agent.maxIterations,
  responseIdleMs: DEFAULTS.browser.responseIdleMs,
  responseTimeoutMs: DEFAULTS.browser.responseTimeoutMs,
  confirmCommands: true,
  checkpointMaxEntries: DEFAULTS.checkpoints.maxEntries,
};

async function readJson(path: string): Promise<Partial<FreegentConfig>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Partial<FreegentConfig>;
  } catch {
    return {};
  }
}

/**
 * Load config: defaults <- global ~/.freegent/config.json
 * <- per-project <cwd>/.freegent/settings.json (highest priority).
 */
function normalizeConfig(input: Partial<FreegentConfig>): FreegentConfig {
  const maxIterations = Number(input.maxIterations ?? DEFAULT_CONFIG.maxIterations);
  const responseIdleMs = Number(input.responseIdleMs ?? DEFAULT_CONFIG.responseIdleMs);
  const responseTimeoutMs = Number(input.responseTimeoutMs ?? DEFAULT_CONFIG.responseTimeoutMs);
  return {
    provider: 'deepseek',
    chatUrl: typeof input.chatUrl === 'string' && input.chatUrl.trim()
      ? input.chatUrl.trim() : DEFAULT_CONFIG.chatUrl,
    headless: typeof input.headless === 'boolean' ? input.headless : DEFAULT_CONFIG.headless,
    maxIterations: Number.isFinite(maxIterations) && maxIterations >= 1
      ? Math.min(Math.floor(maxIterations), 1000) : DEFAULT_CONFIG.maxIterations,
    responseIdleMs: Number.isFinite(responseIdleMs) && responseIdleMs >= 100
      ? Math.min(Math.floor(responseIdleMs), 60_000) : DEFAULT_CONFIG.responseIdleMs,
    responseTimeoutMs: Number.isFinite(responseTimeoutMs) && responseTimeoutMs >= 1_000
      ? Math.min(Math.floor(responseTimeoutMs), 600_000) : DEFAULT_CONFIG.responseTimeoutMs,
    confirmCommands: typeof input.confirmCommands === 'boolean'
      ? input.confirmCommands : DEFAULT_CONFIG.confirmCommands,
    checkpointMaxEntries: Number.isFinite(Number(input.checkpointMaxEntries)) && Number(input.checkpointMaxEntries) >= 10
      ? Math.min(Math.floor(Number(input.checkpointMaxEntries)), 5000) : DEFAULT_CONFIG.checkpointMaxEntries,
  };
}

export async function loadConfig(cwd = process.cwd()): Promise<FreegentConfig> {
  const global = await readJson(CONFIG_FILE);
  const project = await readJson(join(cwd, '.freegent', 'settings.json'));
  return normalizeConfig({ ...global, ...project });
}

export async function saveConfig(config: FreegentConfig): Promise<void> {
  await ensureRoot();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

export async function updateConfig(
  patch: Partial<FreegentConfig>,
): Promise<FreegentConfig> {
  const globalOnly = { ...DEFAULT_CONFIG, ...(await readJson(CONFIG_FILE)) };
  const next = normalizeConfig({ ...globalOnly, ...patch });
  await saveConfig(next);
  return next;
}