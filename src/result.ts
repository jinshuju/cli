import { EXIT_CODES, UsageError, classify } from './errors.js';
import { unknownCommandHelp } from './help.js';
import type { HttpClient } from './http.js';
import type { OutputFormat } from './options.js';
import { json } from './render.js';

export type CliResult = { exitCode: number; stdout: string; stderr: string };

export type CliRuntime = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  client?: HttpClient;
  stdin?: () => string;
  /**
   * Where a streaming command writes as it goes. Without it, what would have
   * streamed is gathered into the result instead, which is what a test wants.
   */
  stdout?: (chunk: string) => void;
  /** How wide a table may be. Defaults to the terminal, or 120 through a pipe. */
  width?: number;
};

export function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, stderr: '' };
}

/**
 * A failure, sorted into its kind. The exit code says which kind without
 * anything being parsed; with `--output json` stderr carries the same in
 * words, plus whatever status and body the server answered with, so a script
 * that reads JSON on the way in reads JSON on the way out as well.
 */
export function fail(error: unknown, output: OutputFormat): CliResult {
  const sorted = classify(error);
  if (output !== 'text') {
    const { exitCode, ...envelope } = sorted;
    return { exitCode, stdout: '', stderr: `${json({ error: envelope })}\n` };
  }
  const wait = sorted.retry_after === undefined ? '' : ` Retry after ${sorted.retry_after}s.`;
  return { exitCode: sorted.exitCode, stdout: '', stderr: `Error: ${sorted.message}${wait}\n` };
}

/** An unknown command is a usage error, and in text mode the help is the message. */
export function unknown(words: readonly string[], output: OutputFormat): CliResult {
  if (output !== 'text') return fail(new UsageError(`Unknown command: jinshuju ${words.join(' ')}`), output);
  return { exitCode: EXIT_CODES.usage, stdout: '', stderr: unknownCommandHelp(words) };
}

/** What `--output` asked for, read before the flags are checked so a failure can honour it. */
export function outputOf(flags: Record<string, unknown>): OutputFormat {
  const asked = flags['--output'];
  return asked === 'json' || asked === 'jsonl' ? asked : 'text';
}
