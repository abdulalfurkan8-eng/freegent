import { Command } from 'commander';
import { logger, type LogLevel } from '../utils/logger.js';
import { startRepl } from './repl.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { initCommand } from './commands/init.js';
import { configCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import { worktreeCommand } from './commands/worktree.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('freegent')
    .description('Autonomous coding and Windows computer agent powered by DeepSeek')
    .option('-v, --verbose', 'verbose logs')
    .option('-d, --debug', 'debug logs')
    .option('-p, --print', 'run one task, print result, and exit (no REPL)')
    .option('--json', 'with -p: emit structured JSON for scripts/CI');

  program.argument('[task...]').action(async (taskParts: string[]) => {
    const opts = program.opts<{
      verbose?: boolean; debug?: boolean; print?: boolean; json?: boolean;
    }>();
    const level: LogLevel =
      opts.json ? 'silent' : opts.debug ? 'debug' : opts.verbose ? 'verbose' : 'normal';
    logger.setLevel(level);
    const task = taskParts.join(' ').trim();

    if (opts.print && task) {
      const { AgentSession } = await import('../agent/session.js');
      const session = new AgentSession();
      const started = Date.now();
      await session.start();
      try {
        const summary = await session.runTask(task);
        if (opts.json) {
          console.log(JSON.stringify({
            ok: true, task, summary,
            toolCalls: session.stats.toolCalls,
            durationMs: Date.now() - started,
          }));
        } else {
          logger.success(summary);
        }
      } catch (err) {
        if (!opts.json) throw err;
        console.log(JSON.stringify({
          ok: false, task,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        }));
        process.exitCode = 1;
      } finally {
        await session.close();
      }
      return;
    }
    await startRepl(task || undefined);
  });

  program.command('init').description('Initialize ~/.freegent').action(initCommand);
  program.command('login').description('Log into the selected web provider once').option('--remote', 'allow LAN remote-control access').action((opts: { remote?: boolean }) => loginCommand(opts));
  program.command('logout').description('Remove saved session').action(logoutCommand);
  program.command('doctor').description('Diagnose setup').action(doctorCommand);
  program
    .command('worktree')
    .description('Create a git worktree for a parallel FreeGent session')
    .argument('<name>', 'branch/worktree name')
    .action(worktreeCommand);
  program
    .command('config')
    .description('Show or set config values')
    .argument('[key]')
    .argument('[value]')
    .action(configCommand);
  return program;
}