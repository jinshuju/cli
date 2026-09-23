import { bindArgs, bindOptions, leadingWords, readStdin, splitArgs } from './args.js';
import { findCommand, type Command } from './commands.js';
import { defaultConfigPath, loadConfig } from './config.js';
import { helpFor, rootHelp } from './help.js';
import { HttpError, JinshujuHttpClient, type HttpClient, type HttpRequest } from './http.js';
import { runLocal } from './local.js';
import { GLOBAL_OPTIONS, LOCAL_OPTIONS, UsageError, type OutputFormat } from './options.js';
import { progress, type Progress } from './progress.js';
import { json, terminalWidth, text } from './render.js';
import { fail, ok, outputOf, unknown, type CliResult, type CliRuntime } from './result.js';
import { VERSION } from './version.js';

export type { CliResult, CliRuntime } from './result.js';

export async function runCli(args: string[] = [], runtime: CliRuntime = {}): Promise<CliResult> {
  // The command has to be found before the line can be split, because only it
  // says which flags take a value. Its own words come first and hold no flags,
  // so they are readable without knowing anything.
  const command = findCommand(leadingWords(args));
  const specs = [...(command?.options ?? []), ...GLOBAL_OPTIONS, ...LOCAL_OPTIONS];
  const { words, flags } = splitArgs(args, specs);
  const stdin = runtime.stdin ?? readStdin;

  if (flags['--version'] || flags['-V']) return ok(VERSION);
  if (args.length === 0) return ok(rootHelp());
  if (flags['--help'] || flags['-h']) return ok(helpFor(words));

  const resource = words[0] as string;
  try {
    if (resource === 'auth' || resource === 'config') return await runLocal(words, flags, runtime, stdin);

    if (!command) return unknown(words, outputOf(flags));

    return await runRemote(command, words, flags, runtime, stdin);
  } catch (error) {
    return fail(error, outputOf(flags));
  }
}

async function runRemote(
  command: Command,
  words: readonly string[],
  flags: Record<string, unknown>,
  runtime: CliRuntime,
  stdin: () => string
): Promise<CliResult> {
  const label = `jinshuju ${command.path.join(' ')}`;
  const specs = [...(command.options ?? []), ...GLOBAL_OPTIONS, ...LOCAL_OPTIONS];
  const options = bindOptions(specs, flags, label, stdin);
  const input = { ...bindArgs(command, words), options };
  const output = (options.output as OutputFormat) ?? 'text';
  const width = runtime.width ?? terminalWidth();

  const client =
    runtime.client ??
    new JinshujuHttpClient(
      loadConfig({
        configPath: (options.config as string) ?? defaultConfigPath,
        env: runtime.env,
        cli: {
          apiKey: options.api_key as string | undefined,
          apiSecret: options.api_secret as string | undefined,
          host: options.host as string | undefined
        }
      })
    );

  // A command that needs more than one round trip, or has to decide how many,
  // runs itself and answers with what should be printed.
  if (command.run) {
    const payload = await command.run(input, client);
    return ok(output === 'json' ? json(payload) : text(payload, width));
  }

  const request = command.request?.(input);
  if (!request) throw new UsageError(`${label} is not available yet`);

  if (options.all && command.paginate) {
    const rows = await readAllPages(client, request, command.paginate, progress());
    const payload = { count: rows.length, data: rows };
    return ok(output === 'json' ? json(payload) : text(payload, width));
  }

  const result = await client.request(request);
  const selected = command.select ? command.select(result) : result;
  if (output === 'json') return ok(json(selected));
  return ok(text(command.render ? command.render(selected) : selected, width));
}

/**
 * More pages than any listing has. A cursor that never runs out would
 * otherwise read forever; stopping here says so instead, with what was read.
 */
const MAX_PAGES = 10_000;

/**
 * Every page of a listing. A cursor is opaque: it goes back exactly as it came.
 */
async function readAllPages(
  client: HttpClient,
  request: HttpRequest,
  paginate: { items: string; cursor: string },
  watching: Progress = { step: () => {}, done: () => {} }
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  let page = 0;
  for (;;) {
    const body = await client.request<Record<string, unknown>>({
      ...request,
      query: { ...request.query, ...(cursor ? { next: cursor } : {}) }
    });
    rows.push(...((body?.[paginate.items] as unknown[] | undefined) ?? []));
    page += 1;
    watching.step(`read ${page} page${page === 1 ? '' : 's'}, ${rows.length} rows…`);
    const next = body?.[paginate.cursor];
    if (next === undefined || next === null || next === '') break;
    // A server answering the cursor it was just given would be read forever.
    if (String(next) === cursor) {
      throw new HttpError(
        `the server answered page ${page} with the cursor it was asked for; stopping rather than looping`,
        200,
        body
      );
    }
    if (page >= MAX_PAGES)
      throw new Error(`stopped after ${MAX_PAGES} pages and ${rows.length} rows; the listing has no end`);
    cursor = String(next);
  }
  watching.done();
  return rows;
}
