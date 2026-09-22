import { readFileSync } from 'node:fs';

import {
  assertConfigKey, defaultConfigPath, getConfig, loadConfig, maskSecret, setConfigValue, unsetConfigValue, type ConfigKey
} from './config.js';
import { loginWithOAuth, refreshOAuthToken, revokeOAuthToken } from './auth.js';
import { progress, type Progress } from './progress.js';
import { COMMANDS, findCommand, type Command, type QueryValues } from './commands.js';
import { commandHelp, helpFor, rootHelp, unknownCommandHelp } from './help.js';
import { JinshujuHttpClient, type HttpClient } from './http.js';
import {
  GLOBAL_OPTIONS, UsageError, optionKey, readJsonInput, type OptionSpec, type OutputFormat
} from './options.js';

export type CliResult = { exitCode: number; stdout: string; stderr: string };

export type CliRuntime = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  client?: HttpClient;
  stdin?: () => string;
  /** How wide a table may be. Defaults to the terminal, or 120 through a pipe. */
  width?: number;
};

/** Everything the local (auth, config) commands read off the command line. */
type LocalOptions = {
  output: OutputFormat;
  configPath: string;
  apiKey?: string;
  apiSecret?: string;
  host?: string;
  authHost?: string;
  clientId?: string;
  scopes?: string;
  noOpen: boolean;
  verify: boolean;
  showSecret: boolean;
};

/** Options the local commands accept on top of the global ones. */
const LOCAL_OPTIONS: readonly OptionSpec[] = [
  { name: '--api-key', type: 'string', placeholder: '<key>', description: 'Override API key' },
  { name: '--api-secret', type: 'string', placeholder: '<secret>', description: 'Override API secret' },
  { name: '--host', type: 'string', placeholder: '<url>', description: 'API host' },
  { name: '--auth-host', type: 'string', placeholder: '<url>', description: 'OAuth host' },
  { name: '--client-id', type: 'string', placeholder: '<id>', description: 'OAuth public client id' },
  { name: '--scopes', type: 'string', placeholder: '<scopes>', description: 'Space-separated OAuth scopes' },
  { name: '--no-open', type: 'boolean', description: 'Print the login URL instead of opening a browser' },
  { name: '--verify', type: 'boolean', description: 'Verify the credentials with a lightweight call' },
  { name: '--show-secret', type: 'boolean', description: 'Show secrets unmasked' }
];

type RawArgs = { words: string[]; flags: Record<string, unknown> };

/**
 * Splits the command line before a command is known: `--help` and an unknown
 * command both have to work without one.
 */
/**
 * The words that name the command: enough to find it, and no more.
 *
 * A flag may come first — `jinshuju --config local.json form list` is what a
 * shell alias expands to, and what anyone arriving from `git -C` or
 * `kubectl --context` writes — so a flag this CLI knows without a command is
 * stepped over, along with its value. Stopping at it instead reported "Unknown
 * command: jinshuju form list" while offering that very command as a
 * suggestion.
 *
 * An unknown flag still ends the scan. Only a command declares those, so by the
 * time one appears the command has been named already.
 */
function leadingWords(argv: readonly string[]): string[] {
  const known = new Map<string, OptionSpec>();
  for (const spec of [...GLOBAL_OPTIONS, ...LOCAL_OPTIONS]) {
    known.set(spec.name, spec);
    if (spec.short) known.set(spec.short, spec);
  }

  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('-') || token === '-') {
      words.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const spec = known.get(equals === -1 ? token : token.slice(0, equals));
    if (!spec) break;
    if (equals === -1 && spec.type !== 'boolean') index += 1;
  }
  return words;
}

/**
 * Splits the command line, knowing which flags take a value.
 *
 * Guessing from the shape of the next token gets two things wrong that a
 * caller has every right to write: `--json -`, where the value is the very
 * character that looks like a flag, and `--yes 12`, where a boolean must not
 * swallow the argument behind it. Both are decided by the option's own type,
 * so the specs are passed in rather than inferred.
 */
function splitArgs(argv: readonly string[], specs: readonly OptionSpec[] = []): RawArgs {
  const takesValue = new Map<string, boolean>();
  for (const spec of specs) {
    takesValue.set(spec.name, spec.type !== 'boolean');
    if (spec.short) takesValue.set(spec.short, spec.type !== 'boolean');
  }

  const words: string[] = [];
  const flags: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--') {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      words.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const next = argv[index + 1];
    // An unknown flag is assumed to take a value, so it reaches bindOptions
    // with whatever followed it and is refused by name rather than by shape.
    const wanted = takesValue.get(flag) ?? true;
    const consumable = wanted && next !== undefined && (next === '-' || !next.startsWith('-'));
    const value = inline ?? (consumable ? (index += 1, next) : true);
    const existing = flags[flag];
    flags[flag] = existing === undefined ? value : ([] as unknown[]).concat(existing as never, value as never);
  }
  return { words, flags };
}

/**
 * Checks the flags against what this command declares. A flag belonging to
 * another command is an error rather than something quietly ignored: that is
 * how a caller learns it asked for something that was never going to happen.
 */
function bindOptions(
  specs: readonly OptionSpec[],
  flags: Record<string, unknown>,
  label: string,
  stdin: () => string
): Record<string, unknown> {
  const byFlag = new Map<string, OptionSpec>();
  for (const spec of specs) {
    byFlag.set(spec.name, spec);
    if (spec.short) byFlag.set(spec.short, spec);
  }

  const bound: Record<string, unknown> = {};
  for (const [flag, value] of Object.entries(flags)) {
    const spec = byFlag.get(flag);
    if (!spec) throw new UsageError(`${label} does not take ${flag}. Run it with --help to see what it does take.`);
    bound[optionKey(spec)] = coerce(spec, value, stdin);
  }
  return bound;
}

function coerce(spec: OptionSpec, value: unknown, stdin: () => string): unknown {
  if (spec.repeatable) return ([] as unknown[]).concat(value as never).map((item) => coerceOne(spec, item, stdin));
  if (Array.isArray(value)) throw new UsageError(`${spec.name} takes a single value, but was given more than once`);
  return coerceOne(spec, value, stdin);
}

function coerceOne(spec: OptionSpec, value: unknown, stdin: () => string): unknown {
  if (spec.type === 'boolean') {
    if (value === true || value === 'true') return true;
    if (value === 'false') return false;
    throw new UsageError(`${spec.name} is a flag and takes no value`);
  }
  if (value === true) throw new UsageError(`${spec.name} needs a value`);
  const text = String(value);
  if (spec.choices && !spec.choices.includes(text)) {
    throw new UsageError(`${spec.name} must be one of ${spec.choices.join(', ')}, got ${JSON.stringify(text)}`);
  }
  if (spec.type === 'integer') {
    if (!/^\d+$/.test(text)) throw new UsageError(`${spec.name} must be a whole number, got ${JSON.stringify(text)}`);
    return Number.parseInt(text, 10);
  }
  if (spec.type === 'list') return text.split(',').map((item) => item.trim()).filter(Boolean);
  if (spec.type === 'json') return readJsonInput(text, stdin);
  return text;
}

function bindArgs(command: Command, words: readonly string[]): { args: Record<string, string>; rest: string[] } {
  const positionals = words.slice(command.path.length);
  const specs = command.args ?? [];
  const args: Record<string, string> = {};
  let rest: string[] = [];
  specs.forEach((arg, index) => {
    if (arg.variadic) {
      rest = positionals.slice(index);
      if (arg.required && rest.length === 0) {
        throw new UsageError(`jinshuju ${command.path.join(' ')} needs <${arg.name}>: ${arg.description}`);
      }
      return;
    }
    const value = positionals[index];
    if (value === undefined) {
      if (arg.required) throw new UsageError(`jinshuju ${command.path.join(' ')} needs <${arg.name}>: ${arg.description}`);
      return;
    }
    args[arg.name] = value;
  });
  if (!specs.some((arg) => arg.variadic)) {
    const extra = positionals.slice(specs.length);
    if (extra.length > 0) {
      throw new UsageError(`jinshuju ${command.path.join(' ')} takes no argument ${JSON.stringify(extra[0])}`);
    }
  }
  return { args, rest };
}

function localOptions(flags: Record<string, unknown>, stdin: () => string): LocalOptions {
  const bound = bindOptions([...GLOBAL_OPTIONS, ...LOCAL_OPTIONS], flags, 'this command', stdin);
  return {
    output: (bound.output as OutputFormat) ?? 'text',
    configPath: (bound.config as string) ?? defaultConfigPath,
    apiKey: bound.api_key as string | undefined,
    apiSecret: bound.api_secret as string | undefined,
    host: bound.host as string | undefined,
    authHost: bound.auth_host as string | undefined,
    clientId: bound.client_id as string | undefined,
    scopes: bound.scopes as string | undefined,
    noOpen: Boolean(bound.no_open),
    verify: Boolean(bound.verify),
    showSecret: Boolean(bound.show_secret)
  };
}

export const VERSION = '0.1.0';

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, stderr: '' };
}

function fail(message: string, exitCode = 2): CliResult {
  return { exitCode, stdout: '', stderr: `Error: ${message}\n` };
}

const MAX_CELL = 120;

/** What a table is allowed to be wide when nobody is watching it on a screen. */
const PIPED_WIDTH = 120;

/** Columns that say which row this is; they earn their place before any value. */
const LEADING_COLUMNS = ['token', 'api_code', 'serial_number', 'id', 'name', 'title', 'label', 'type', 'state', 'status'];

/**
 * Timestamps go last, however early they appear in the payload. On a listing of
 * rows they are the least of what the reader came for, and taking them in
 * payload order is what left `entry list` showing two of a form's ten fields.
 */
const TRAILING_COLUMNS = ['created_at', 'updated_at'];

/**
 * A column that names the row rather than saying anything about it. The listed
 * ones plus whatever ends in `_token` or `_id`, because a search answers with
 * `form_token` and a row showing only that has told the reader nothing.
 */
function identifies(column: string): boolean {
  return LEADING_COLUMNS.includes(column) || /(^|_)(token|id)$/.test(column);
}

export function terminalWidth(stream: NodeJS.WriteStream = process.stdout): number {
  return stream.isTTY && stream.columns > 0 ? stream.columns : PIPED_WIDTH;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function text(value: unknown, width: number): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return renderList(value, width);
  if (typeof value === 'object') return renderObject(value as Record<string, unknown>, width);
  return String(value);
}

function renderObject(value: Record<string, unknown>, width: number): string {
  const listKey = ['data', 'items', 'forms', 'entries', 'views'].find((key) => Array.isArray(value[key]));

  if (listKey) {
    // Everything beside the listing is rendered, not just its scalars. Filtering
    // to scalars here was another way for a payload to lose a key on the way to
    // the page — the warnings an import answers with, say.
    const heading = Object.entries(value)
      .filter(([key]) => key !== listKey)
      .map(([key, fieldValue]) => renderEntry(key, fieldValue, width));
    const listText = renderList(value[listKey] as unknown[], width);
    return [...heading, `${listKey}:`, listText].filter(Boolean).join('\n');
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return entries.map(([key, fieldValue]) => renderEntry(key, fieldValue, width)).join('\n');
}

/**
 * A setting is an object of objects, and printing it as JSON asks the reader to
 * parse braces to find one flag. Nesting goes one indent deeper instead, so the
 * shape stays visible and every leaf reads as `key: value`.
 */
function renderEntry(key: string, value: unknown, width: number): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? `${key}: (empty)` : `${key}:\n${indent(renderList(value, width))}`;
  }
  if (value !== null && typeof value === 'object') {
    const block = renderObject(value as Record<string, unknown>, width);
    return block === '{}' ? `${key}: {}` : `${key}:\n${indent(block)}`;
  }
  return `${key}: ${formatCell(value)}`;
}

function indent(block: string): string {
  return block.split('\n').map((line) => (line ? `  ${line}` : line)).join('\n');
}

function renderList(values: unknown[], width: number): string {
  if (values.length === 0) return '(empty)';
  if (!values.every(isRecord)) return values.map((item) => formatField(item)).join('\n');

  const { rows, headings } = splitLabels((values as Record<string, unknown>[]).map(unwrapKeyed));
  if (rows.some(hasEssentialList)) return rows.map((row) => renderObject(row, width)).join('\n\n');

  const heading = (column: string): string => headings.get(column) ?? column;
  const candidates = candidateColumns(rows);
  if (candidates.length === 0) return rows.map((row) => json(row)).join('\n');

  const columns: string[] = [];
  const widths: number[] = [];
  let used = 0;
  for (const column of candidates) {
    const columnWidth = Math.max(displayWidth(heading(column)), ...rows.map((row) => displayWidth(formatCell(row[column]))));
    const next = used + (columns.length === 0 ? 0 : 2) + columnWidth;
    // The first column goes in whatever it costs: a table of nothing is worse
    // than a table too wide.
    if (columns.length > 0 && next > width) break;
    columns.push(column);
    widths.push(columnWidth);
    used = next;
  }

  // A row that says nothing but its own name says nothing at all — and the
  // column that would have explained it is exactly the one a narrow terminal
  // drops. `entry search` keeps a form it could not read *with the reason*, and
  // the budget must not be what throws that reason away. A row left with only
  // its identity buys back one column, whatever the width says.
  const told = (row: Record<string, unknown>, column: string): boolean =>
    !identifies(column) && formatCell(row[column]) !== '';
  for (const row of rows) {
    if (columns.some((column) => told(row, column))) continue;
    const rescued = candidates.find((column) => !columns.includes(column) && told(row, column));
    if (!rescued) continue;
    columns.push(rescued);
    widths.push(Math.max(displayWidth(heading(rescued)), ...rows.map((other) => displayWidth(formatCell(other[rescued])))));
  }

  const header = columns.map((column, index) => pad(heading(column), widths[index])).join('  ');
  const separator = widths.map((columnWidth) => '-'.repeat(columnWidth)).join('  ');
  const body = rows.map((row) => columns.map((column, index) => pad(formatCell(row[column]), widths[index])).join('  '));
  return [header, separator, ...body].join('\n');
}

/**
 * Every column the rows could show, best first. How many of them fit is the
 * caller's question, and it needs their widths to answer it.
 */
function candidateColumns(rows: Record<string, unknown>[]): string[] {
  const present = (key: string): boolean =>
    rows.some((row) => Object.prototype.hasOwnProperty.call(row, key) && isCell(row[key]));

  const seen = new Set<string>(LEADING_COLUMNS.filter(present));
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (isCell(value) && !TRAILING_COLUMNS.includes(key)) seen.add(key);
    }
  }
  for (const key of TRAILING_COLUMNS.filter(present)) seen.add(key);
  return [...seen];
}

/**
 * A form's fields arrive as `{ "field_1": { label, type, ... } }`, one key per
 * row. A table of those reads as a column per field and nothing in it, so the
 * key becomes a cell of its own row instead.
 */
function unwrapKeyed(row: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(row);
  if (entries.length !== 1) return row;
  const [key, value] = entries[0];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return row;
  return { api_code: key, ...(value as Record<string, unknown>) };
}

/**
 * `--labels` answers each field as `{ label, value }`. A cell cannot hold a
 * pair, and a column of pairs is no column at all — which is why the values
 * used to vanish from the table entirely. The pair is split instead: the value
 * becomes the cell, the label becomes the column's heading. Columns stay keyed
 * by api_code, because two fields may carry the same label.
 */
function splitLabels(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; headings: Map<string, string> } {
  const headings = new Map<string, string>();
  const split = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!isLabelled(value)) {
        out[key] = value;
        continue;
      }
      const { label, value: cell } = value as { label: unknown; value: unknown };
      if (typeof label === 'string' && label !== '') headings.set(key, label);
      out[key] = cell;
    }
    return out;
  });
  return { rows: split, headings };
}

function isLabelled(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 2 && keys.includes('label') && keys.includes('value');
}

/**
 * A row carrying a list of its own has no cell a table could put it in, and the
 * table drops it. Usually that is the right trade — a field's `choices` are
 * detail, and the row still says what the field is. An analysis' buckets are
 * not detail: they are the answer, and a table of `entry summary` without them
 * prints how many people answered and never what they answered.
 *
 * Which is which is not readable off the shape — both are a list of objects
 * beside a handful of scalars — so the lists worth breaking the table for are
 * named, the way `renderObject` names the keys that hold a listing.
 */
const ESSENTIAL_LISTS = ['buckets'];

function hasEssentialList(row: Record<string, unknown>): boolean {
  return ESSENTIAL_LISTS.some((key) => {
    const value = row[key];
    return Array.isArray(value) && value.length > 0 && value.every(isRecord);
  });
}

function isRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * Whether a value earns its key a column. A list of values does: a
 * multiple-choice answer is a list, and so is the `serial_numbers` a search
 * answers with. Treating those as unprintable dropped the column — which meant
 * `--fields field_6` left out field_6, and `entry search` said how many rows
 * matched without ever saying which.
 *
 * An empty list earns nothing, though. A column that is `[]` in every row is a
 * heading with a blank under it for as far as the table goes.
 */
function isCell(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isScalar);
  return isScalar(value);
}

function formatField(value: unknown): string {
  if (isScalar(value)) return formatCell(value);
  return json(value);
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every(isScalar)) return clip(value.map(formatCell).join(', '));
  return clip(JSON.stringify(value));
}

/**
 * One rich text field is longer than the rest of a form put together, and it
 * wraps over a screen of terminal. Text is the readable format; whoever wants
 * the whole value asks for --output json.
 */
function clip(value: string): string {
  return value.length <= MAX_CELL ? value : `${value.slice(0, MAX_CELL)}… (${value.length} chars)`;
}

/**
 * A column is padded to what the terminal shows, not to how many code points
 * the value holds: a Chinese label takes two cells per character, so counting
 * length leaves every table with a Chinese column ragged.
 */
function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += isWide(char.codePointAt(0) as number) ? 2 : 1;
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

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

    if (!command) return { exitCode: 1, stdout: '', stderr: unknownCommandHelp(words) };

    return await runRemote(command, words, flags, runtime, stdin);
  } catch (error) {
    return fail((error as Error).message);
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

  const client = runtime.client ?? new JinshujuHttpClient(loadConfig({
    configPath: (options.config as string) ?? defaultConfigPath,
    env: runtime.env,
    cli: { apiKey: options.api_key as string | undefined, apiSecret: options.api_secret as string | undefined, host: options.host as string | undefined }
  }));

  // A command that needs more than one round trip handles itself. Answering
  // undefined means "this call is the ordinary one", so `entry create` only
  // takes the long way when a file is actually attached.
  if (command.run) {
    const payload = await command.run(input, client);
    if (payload !== undefined) return ok(output === 'json' ? json(payload) : text(payload, width));
  }

  const request = command.request?.(input);
  if (!request) throw new UsageError(`${label} is not available yet`);

  if (options.all && command.paginate) {
    const rows = await readAllPages(client, request, command.paginate, progress());
    const payload = { count: rows.length, data: rows };
    return ok(output === 'json' ? json(payload) : text(payload, width));
  }

  const result = await client.request({ method: request.method, path: withQuery(request.path, request.query), body: request.body });
  const selected = command.select ? command.select(result) : result;
  if (output === 'json') return ok(json(selected));
  return ok(text(command.render ? command.render(selected) : selected, width));
}

/**
 * Every page of a listing. A cursor is opaque: it goes back exactly as it came.
 */
async function readAllPages(
  client: HttpClient,
  request: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; query?: QueryValues; body?: unknown },
  paginate: { items: string; cursor: string },
  watching: Progress = { step: () => {}, done: () => {} }
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  let page = 0;
  for (;;) {
    const query = { ...request.query, ...(cursor ? { next: cursor } : {}) };
    const body = await client.request<Record<string, unknown>>({ method: request.method, path: withQuery(request.path, query), body: request.body });
    rows.push(...((body?.[paginate.items] as unknown[] | undefined) ?? []));
    page += 1;
    watching.step(`read ${page} page${page === 1 ? '' : 's'}, ${rows.length} rows…`);
    const next = body?.[paginate.cursor];
    if (next === undefined || next === null || next === '') break;
    cursor = String(next);
  }
  watching.done();
  return rows;
}

/**
 * A list value repeats its parameter as `name[]=a&name[]=b`, which is how Rails
 * reads a list. Joining them with a comma would ask for one keyword containing
 * a comma instead of two keywords.
 */
function withQuery(path: string, query?: QueryValues): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      params.set(name, value);
    } else {
      for (const item of value) params.append(`${name}[]`, item);
    }
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    throw new UsageError('could not read JSON from stdin');
  }
}

async function runLocal(
  words: readonly string[],
  flags: Record<string, unknown>,
  runtime: CliRuntime,
  stdin: () => string
): Promise<CliResult> {
  const options = localOptions(flags, stdin);
  const key = words.slice(0, 2).join(' ');
  switch (key) {
    case 'auth login':
      return await authLogin(options, runtime);
    case 'auth status':
      return await authStatus(options, runtime);
    case 'auth refresh':
      return await authRefresh(options, runtime);
    case 'auth logout':
      return await authLogout(options, runtime);
    case 'config get':
      return configGet(words, options);
    case 'config set':
      return configSet(words, options);
    case 'config unset':
      return configUnset(words, options);
    default:
      return { exitCode: 1, stdout: '', stderr: unknownCommandHelp(words) };
  }
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing argument <${name}>`);
  return value;
}

function createClient(options: LocalOptions, runtime: CliRuntime): HttpClient {
  return runtime.client ?? new JinshujuHttpClient(loadConfig({ configPath: options.configPath, env: runtime.env, cli: { apiKey: options.apiKey, apiSecret: options.apiSecret, host: options.host } }));
}

async function authLogin(options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  const result = await loginWithOAuth({
    configPath: options.configPath,
    env: runtime.env,
    host: options.host,
    authHost: options.authHost,
    clientId: options.clientId,
    scopes: options.scopes,
    openBrowser: !options.noOpen
  });
  const payload = { authenticated: true, mode: 'oauth', auth_host: result.token.auth_host, client_id: result.token.client_id, scope: result.token.scope, expires_at: result.token.expires_at };
  if (options.output === 'json') return ok(json(payload));
  return ok(`Authenticated with OAuth.\nConfig: ${options.configPath}`);
}

async function authStatus(options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  const config = loadConfig({ configPath: options.configPath, env: runtime.env, cli: { apiKey: options.apiKey, apiSecret: options.apiSecret, host: options.host, authHost: options.authHost, clientId: options.clientId } });
  const authenticated = Boolean(config.accessToken || (config.apiKey && config.apiSecret) || config.auth?.access_token);
  const mode = config.accessToken
    ? 'access_token'
    : config.apiKey && config.apiSecret
      ? 'api_key_secret'
      : config.auth?.access_token
        ? 'oauth'
        : 'none';
  const payload = {
    authenticated,
    mode,
    host: config.host,
    auth_host: config.authHost,
    sources: config.sources,
    source: mode === 'access_token' ? config.sources.accessToken
      : mode === 'api_key_secret' ? config.sources.apiKey
        : mode === 'oauth' ? config.sources.auth : 'missing',
    oauth: config.auth ? { client_id: config.auth.client_id, scope: config.auth.scope, expires_at: config.auth.expires_at, has_refresh_token: Boolean(config.auth.refresh_token) } : undefined
  };
  if (options.verify && authenticated) {
    await createClient(options, runtime).request({ method: 'GET', path: '/api/v1/forms' });
  }
  if (options.output === 'json') return ok(json(payload));
  if (mode === 'access_token') return ok(`Authenticated with an access token (from ${config.sources.accessToken}).`);
  if (mode === 'oauth') return ok('Authenticated with OAuth.');
  if (mode === 'api_key_secret') return ok('Authenticated with API Key / Secret.');
  return ok('Missing authentication. Run `jinshuju auth login`, or set an access token, or configure API Key / Secret.');
}

async function authRefresh(options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  const config = loadConfig({ configPath: options.configPath, env: runtime.env, cli: { host: options.host, authHost: options.authHost, clientId: options.clientId } });
  const auth = await refreshOAuthToken(config);
  if (options.output === 'json') return ok(json({ authenticated: true, mode: 'oauth', expires_at: auth.expires_at, scope: auth.scope }));
  return ok('OAuth token refreshed.');
}

async function authLogout(options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  const config = loadConfig({ configPath: options.configPath, env: runtime.env });
  await revokeOAuthToken(config);
  return ok(options.output === 'json' ? json({ authenticated: false }) : 'Logged out.');
}

function configGet(positionals: readonly string[], options: LocalOptions): CliResult {
  const requestedKey = positionals[2];
  if (requestedKey) assertConfigKey(requestedKey);
  const config = getConfig(options.configPath);
  const secrets = new Set(['access_token', 'api_key', 'api_secret']);
  const renderValue = (key: string, value: string | undefined) =>
    options.showSecret || !secrets.has(key) ? value : maskSecret(value);
  let payload: Record<string, string | undefined>;
  if (requestedKey) {
    const configKey = requestedKey as ConfigKey;
    payload = { [configKey]: renderValue(configKey, config[configKey]) };
  } else {
    payload = {
      access_token: renderValue('access_token', config.access_token),
      api_key: renderValue('api_key', config.api_key),
      api_secret: renderValue('api_secret', config.api_secret)
    };
  }
  if (options.output === 'json') return ok(json(payload));
  return ok(Object.entries(payload).map(([k, v]) => `${k}: ${v ?? '(unset)'}`).join('\n'));
}

function configSet(positionals: readonly string[], options: LocalOptions): CliResult {
  const key = requireArg(positionals[2], 'key');
  assertConfigKey(key);
  const value = requireArg(positionals[3], 'value');
  setConfigValue(options.configPath, key, value);
  return ok(`Set ${key}`);
}

function configUnset(positionals: readonly string[], options: LocalOptions): CliResult {
  const key = requireArg(positionals[2], 'key');
  assertConfigKey(key);
  unsetConfigValue(options.configPath, key);
  return ok(`Unset ${key}`);
}
