import { readFileSync } from 'node:fs';

import {
  assertConfigKey, defaultConfigPath, getConfig, loadConfig, maskSecret, setConfigValue, unsetConfigValue, type ConfigKey
} from './config.js';
import { loginWithOAuth, refreshOAuthToken, revokeOAuthToken } from './auth.js';
import { COMMANDS, findCommand, type Command } from './commands.js';
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
function splitArgs(argv: readonly string[]): RawArgs {
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
    const value = inline ?? (next !== undefined && !next.startsWith('-') ? (index += 1, next) : true);
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

function bindArgs(command: Command, words: readonly string[]): Record<string, string> {
  const positionals = words.slice(command.path.length);
  const args: Record<string, string> = {};
  (command.args ?? []).forEach((arg, index) => {
    const value = positionals[index];
    if (value === undefined) {
      if (arg.required) throw new UsageError(`jinshuju ${command.path.join(' ')} needs <${arg.name}>: ${arg.description}`);
      return;
    }
    args[arg.name] = value;
  });
  const extra = positionals.slice((command.args ?? []).length);
  if (extra.length > 0) {
    throw new UsageError(`jinshuju ${command.path.join(' ')} takes no argument ${JSON.stringify(extra[0])}`);
  }
  return args;
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

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return renderList(value);
  if (typeof value === 'object') return renderObject(value as Record<string, unknown>);
  return String(value);
}

function renderObject(value: Record<string, unknown>): string {
  const listKey = ['data', 'items', 'forms', 'entries', 'views'].find((key) => Array.isArray(value[key]));
  const scalarLines = Object.entries(value)
    .filter(([key]) => key !== listKey)
    .filter(([, fieldValue]) => !Array.isArray(fieldValue) && (fieldValue === null || typeof fieldValue !== 'object'))
    .map(([key, fieldValue]) => `${key}: ${formatCell(fieldValue)}`);

  if (listKey) {
    const listText = renderList(value[listKey] as unknown[]);
    return [...scalarLines, `${listKey}:`, listText].filter(Boolean).join('\n');
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return entries.map(([key, fieldValue]) => `${key}: ${formatField(fieldValue)}`).join('\n');
}

function renderList(values: unknown[]): string {
  if (values.length === 0) return '(empty)';
  if (!values.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
    return values.map((item) => formatField(item)).join('\n');
  }

  const rows = values as Record<string, unknown>[];
  const columns = collectColumns(rows);
  if (columns.length === 0) return rows.map((row) => json(row)).join('\n');

  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => formatCell(row[column]).length)));
  const header = columns.map((column, index) => column.padEnd(widths[index])).join('  ');
  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = rows.map((row) => columns.map((column, index) => formatCell(row[column]).padEnd(widths[index])).join('  '));
  return [header, separator, ...body].join('\n');
}

function collectColumns(rows: Record<string, unknown>[]): string[] {
  const preferred = ['token', 'serial_number', 'id', 'name', 'title', 'label', 'type', 'state', 'status', 'created_at', 'updated_at'];
  const seen = new Set<string>();
  for (const key of preferred) {
    if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, key) && isScalar(row[key]))) seen.add(key);
  }
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (seen.size >= 6) return [...seen];
      if (isScalar(value)) seen.add(key);
    }
  }
  return [...seen];
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function formatField(value: unknown): string {
  if (isScalar(value)) return formatCell(value);
  return json(value);
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export async function runCli(args: string[] = [], runtime: CliRuntime = {}): Promise<CliResult> {
  const { words, flags } = splitArgs(args);
  const stdin = runtime.stdin ?? readStdin;

  if (flags['--version'] || flags['-v']) return ok(VERSION);
  if (args.length === 0) return ok(rootHelp());
  if (flags['--help'] || flags['-h']) return ok(helpFor(words));

  const resource = words[0] as string;
  try {
    if (resource === 'auth' || resource === 'config') return await runLocal(words, flags, runtime, stdin);

    const command = findCommand(words);
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
  const input = { args: bindArgs(command, words), options };
  const output = (options.output as OutputFormat) ?? 'text';

  const client = runtime.client ?? new JinshujuHttpClient(loadConfig({
    configPath: (options.config as string) ?? defaultConfigPath,
    env: runtime.env,
    cli: { apiKey: options.api_key as string | undefined, apiSecret: options.api_secret as string | undefined, host: options.host as string | undefined }
  }));

  const request = command.request?.(input);
  if (!request) throw new UsageError(`${label} is not available yet`);

  if (options.all && command.paginate) {
    const rows = await readAllPages(client, request, command.paginate);
    const payload = { count: rows.length, data: rows };
    return ok(output === 'json' ? json(payload) : text(payload));
  }

  const result = await client.request({ method: request.method, path: withQuery(request.path, request.query), body: request.body });
  const selected = command.select ? command.select(result) : result;
  return ok(output === 'json' ? json(selected) : text(selected));
}

/**
 * Every page of a listing. A cursor is opaque: it goes back exactly as it came.
 */
async function readAllPages(
  client: HttpClient,
  request: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; query?: Record<string, string | undefined>; body?: unknown },
  paginate: { items: string; cursor: string }
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query = { ...request.query, ...(cursor ? { next: cursor } : {}) };
    const body = await client.request<Record<string, unknown>>({ method: request.method, path: withQuery(request.path, query), body: request.body });
    rows.push(...((body?.[paginate.items] as unknown[] | undefined) ?? []));
    const next = body?.[paginate.cursor];
    if (next === undefined || next === null || next === '') break;
    cursor = String(next);
  }
  return rows;
}

function withQuery(path: string, query?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(name, value);
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
