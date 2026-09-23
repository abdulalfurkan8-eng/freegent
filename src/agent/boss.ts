import chalk from 'chalk';
import { AgentSession } from './session.js';
import { z } from 'zod';

export interface BossResult {
  summary: string;
  merged: string;
  duration: number;
  failures: number;
}

/**
 * Boss v3: SIMPLE & SMART
 * - Analyzes task
 * - Breaks into 3-5 simple steps
 * - Executes sequentially
 * - Shows progress
 * - NO complex parallel stuff
 */
export async function runBossMode(
  session: AgentSession,
  task: string,
): Promise<BossResult> {
  const start = Date.now();
  console.log(chalk.blue('\n BOSS: ' + task.slice(0, 80)));
  console.log(chalk.blue('\u2500'.repeat(80)) + '\n');

  // Boss creates simple step-by-step plan
  const planPrompt = `You are the senior planner for a software/computer agent. Analyze this task before execution.

TASK:
"${task}"

Create a dependency-aware plan of 3-8 small steps. Each step must include an observable acceptance criterion and a short reason/evidence target. Separate investigation, implementation, verification, and review. Do not assume a tool or application capability that has not been observed. Include investigation before mutation when the task is a bug or unfamiliar codebase. Include verification and a final regression/user-experience check. If the task involves a GUI, include observe -> act -> observe -> verify rather than assuming coordinates remain valid.

Respond with ONLY JSON:
{"steps":[{"text":"inspect the relevant code","acceptance":"relevant entry point and callers identified"},{"text":"implement the fix","acceptance":"target behavior is changed without unrelated edits"}]}

Do not invent files, APIs, or test commands; the executor will discover them. Prefer evidence-driven steps over generic boilerplate.`;

  let steps: string[] = [];
  try {
    const reply = await session.askOnce(planPrompt);
    const raw = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
    const json = z.object({ steps: z.array(z.union([z.string(), z.object({ text: z.string(), acceptance: z.string().optional(), reason: z.string().optional() })])).max(8) }).parse(raw);
    steps = json.steps.map((s: string | { text: string; acceptance?: string; reason?: string }) => {
          if (typeof s === 'string') return s;
          if (s && typeof s.text === 'string') {
            return s.acceptance ? `${s.text} [verify: ${s.acceptance}]${s.reason ? ` [why: ${s.reason}]` : ''}` : s.text;
          }
          return '';
        }).filter(Boolean);
  } catch {
    steps = [];
  }

  if (steps.length === 0) {
    console.log(chalk.yellow('WARN No plan - running directly...\n'));
    try {
      const result = await session.runTask(task);
      return {
        summary: 'Completed',
        merged: result,
        duration: Date.now() - start,
        failures: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        summary: 'Failed: ' + msg,
        merged: msg,
        duration: Date.now() - start,
        failures: 1,
      };
    }
  }

  // Execute steps one by one
  console.log(chalk.green(`PLAN ${steps.length} steps:\n`));
  steps.forEach((s, i) => console.log(chalk.dim(`  ${i + 1}. ${s}`)));
  console.log(chalk.blue('\u2500'.repeat(80)) + '\n');

  const results: string[] = [];
  let failures = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(chalk.bold(`Step Step ${i + 1}/${steps.length}: ${step}`));

    try {
      const result = await session.runTask(step);
      console.log(chalk.green(`OK Done\n`));
      results.push(result);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`FAIL Failed: ${msg}\n`));
      results.push('FAILED: ' + msg);
    }
  }

  // Summary
  console.log(chalk.blue('\u2500'.repeat(80)));
  console.log(failures === 0
    ? chalk.green(`OK All ${steps.length} steps completed!`)
    : chalk.yellow(`WARN  ${failures} step(s) failed`));
  console.log(chalk.blue('\u2500'.repeat(80)) + '\n');

  return {
    summary: failures === 0 ? 'All steps completed' : `${failures} steps failed`,
    merged: results.join('\n\n'),
    duration: Date.now() - start,
    failures,
  };
}