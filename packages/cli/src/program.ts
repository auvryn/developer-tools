import { Command, CommanderError, Option } from 'commander';

import { registerAccountCommands } from './commands/account.js';
import { registerModelCommands } from './commands/models.js';
import { registerResultCommands } from './commands/results.js';
import { registerWorkloadCommands } from './commands/workloads.js';
import {
  Context,
  EXIT,
  type GlobalOptions,
  type Io,
  UnsuccessfulOutcome,
  UsageError,
} from './context.js';

/** What a command's action does with its context; a number overrides the exit code. */
export type Action<Args extends unknown[]> = (
  context: Context,
  options: Record<string, unknown>,
  ...args: Args
) => Promise<number | void>;

/** Wraps an action: context, error reporting and exit codes. */
export type Define = <Args extends unknown[]>(
  action: Action<Args>,
) => (...raw: unknown[]) => Promise<void>;

const HELP_FOOTER = `
Environment:
  AUVRYN_API_KEY     API key (required for API commands; never passed as a flag)
  AUVRYN_API_URL     API URL (default https://api.auvrynspace.com; --api-url overrides)
  AUVRYN_PROJECT_ID  Default project (--project overrides)

Exit codes: 0 success · 1 API or network error · 2 usage or configuration · 3 finished unsuccessfully
Docs: docs/cli/README.md`;

/** Runs the CLI with `argv` (without node and script) and returns the exit code. */
export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  let exitCode: number = EXIT.ok;
  const program = new Command('auvryn');

  const define: Define =
    <Args extends unknown[]>(action: Action<Args>) =>
    async (...raw: unknown[]) => {
      const command = raw.at(-1) as Command;
      const options = command.optsWithGlobals<Record<string, unknown> & GlobalOptions>();
      const context = new Context(io, options);
      try {
        const code = await action(context, options, ...(raw.slice(0, -2) as Args));
        exitCode = code ?? EXIT.ok;
      } catch (error) {
        exitCode = error instanceof UnsuccessfulOutcome ? EXIT.unsuccessful : context.fail(error);
      }
    };

  program
    .description(
      'Operate Auvryn from a terminal or CI: models, validation, sandbox, areas, estimates, executions, results and usage.',
    )
    .version(io.version, '-v, --version', 'Print the CLI version')
    .addOption(new Option('--json', 'Print only JSON on stdout (for scripts, CI and agents)'))
    .addOption(new Option('-q, --quiet', 'No progress messages on stderr'))
    .addOption(new Option('--api-url <url>', 'API URL (overrides AUVRYN_API_URL)'))
    .addOption(new Option('-p, --project <projectId>', 'Project (overrides AUVRYN_PROJECT_ID)'))
    .addHelpText('after', HELP_FOOTER)
    .showHelpAfterError('(run with --help for usage)')
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
    })
    .exitOverride();

  registerAccountCommands(program, define);
  registerModelCommands(program, define);
  registerWorkloadCommands(program, define);
  registerResultCommands(program, define);

  for (const command of program.commands) {
    command.exitOverride();
    for (const sub of command.commands) {
      sub.exitOverride();
    }
  }

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version are successful; anything else is a usage error.
      return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (error instanceof UsageError) {
      return new Context(io, program.opts<GlobalOptions>()).fail(error);
    }
    throw error;
  }
  return exitCode;
}

/** For required options: the value, or a usage error. */
export function required(options: Record<string, unknown>, name: string, flag: string): string {
  const value = options[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`${flag} is required.`);
  }
  return value.trim();
}

/** For optional string options. */
export function optional(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
