import { assertConfigKey, defaultConfigPath, getConfig, loadConfig, maskSecret, setConfigValue, unsetConfigValue, type ConfigKey } from './config.js';
import { helpByCommand, rootHelp } from './help.js';
import { JinshujuHttpClient, type HttpClient } from './http.js';
import { parseJsonPayload, validateCreateFormPayload } from './payload.js';

export type CliResult = { exitCode: number; stdout: string; stderr: string };

export type CliRuntime = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  client?: HttpClient;
};

type GlobalOptions = {
  output: 'text' | 'json';
  configPath: string;
  apiKey?: string;
  apiSecret?: string;
  help: boolean;
  verify: boolean;
  showSecret: boolean;
  jsonPayload?: string;
  page?: string;
  perPage?: string;
};

type ParsedArgs = {
  positionals: string[];
  options: GlobalOptions;
};

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, stderr: '' };
}

function fail(message: string, exitCode = 2): CliResult {
  return { exitCode, stdout: '', stderr: `Error: ${message}\n` };
}

function parseArgs(args: string[]): ParsedArgs {
  const options: GlobalOptions = {
    output: 'text',
    configPath: defaultConfigPath,
    help: false,
    verify: false,
    showSecret: false
  };
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--output':
        options.output = readOptionValue(args, ++i, '--output') as 'text' | 'json';
        break;
      case '--config':
        options.configPath = readOptionValue(args, ++i, '--config');
        break;
      case '--api-key':
        options.apiKey = readOptionValue(args, ++i, '--api-key');
        break;
      case '--api-secret':
        options.apiSecret = readOptionValue(args, ++i, '--api-secret');
        break;
      case '--json':
        options.jsonPayload = readOptionValue(args, ++i, '--json');
        break;
      case '--verify':
        options.verify = true;
        break;
      case '--show-secret':
        options.showSecret = true;
        break;
      case '--page':
        options.page = readOptionValue(args, ++i, '--page');
        break;
      case '--per-page':
        options.perPage = readOptionValue(args, ++i, '--per-page');
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
        positionals.push(arg);
    }
  }

  if (options.output !== 'text' && options.output !== 'json') {
    throw new Error('--output must be text or json');
  }

  return { positionals, options };
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function commandKey(positionals: string[]): string {
  if (positionals[0] === 'form' && positionals[1] === 'view' && positionals[2] === 'entry') return 'form view entry list';
  if (positionals[0] === 'form' && positionals[1] === 'entry') return `form entry ${positionals[2] ?? ''}`.trim();
  if (positionals[0] === 'form' && positionals[1] === 'view') return `form view ${positionals[2] ?? ''}`.trim();
  return positionals.slice(0, 2).join(' ').trim() || positionals[0] || '';
}

function paginatedPath(path: string, options: GlobalOptions): string {
  const params = new URLSearchParams();
  if (options.page) params.set('page', options.page);
  if (options.perPage) params.set('per_page', options.perPage);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
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
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return fail((error as Error).message);
  }

  const key = commandKey(parsed.positionals);
  if (parsed.options.help || args.length === 0) {
    return ok(helpByCommand.get(key) ?? rootHelp);
  }

  try {
    switch (key) {
      case 'auth status':
        return await authStatus(parsed.options, runtime);
      case 'config get':
        return configGet(parsed.positionals, parsed.options);
      case 'config set':
        return configSet(parsed.positionals, parsed.options);
      case 'config unset':
        return configUnset(parsed.positionals, parsed.options);
      case 'form list':
        return await apiGet(paginatedPath('/api/v1/forms', parsed.options), parsed.options, runtime);
      case 'form get':
        return await apiGet(`/api/v1/forms/${requireArg(parsed.positionals[2], 'form-token')}`, parsed.options, runtime);
      case 'form create':
        return await formCreate(parsed.options, runtime);
      case 'form entry list':
        return await apiGet(paginatedPath(`/api/v1/forms/${requireArg(parsed.positionals[3], 'form-token')}/entries`, parsed.options), parsed.options, runtime);
      case 'form entry get':
        return await apiGet(`/api/v1/forms/${requireArg(parsed.positionals[3], 'form-token')}/entries/${requireArg(parsed.positionals[4], 'entry-serial-number')}`, parsed.options, runtime);
      case 'form entry create':
        return await entryCreate(parsed.positionals, parsed.options, runtime);
      case 'form view list':
        return await apiGet(`/api/v1/forms/${requireArg(parsed.positionals[3], 'form-token')}/views`, parsed.options, runtime);
      case 'form view get':
        return await apiGet(`/api/v1/forms/${requireArg(parsed.positionals[3], 'form-token')}/views/${requireArg(parsed.positionals[4], 'view-token')}`, parsed.options, runtime);
      case 'form view entry list':
        return await apiGet(paginatedPath(`/api/v1/forms/${requireArg(parsed.positionals[4], 'form-token')}/views/${requireArg(parsed.positionals[5], 'view-token')}/entries`, parsed.options), parsed.options, runtime);
      default:
        return fail(`Unknown command: ${parsed.positionals.join(' ')}`);
    }
  } catch (error) {
    return fail((error as Error).message);
  }
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing argument <${name}>`);
  return value;
}

function createClient(options: GlobalOptions, runtime: CliRuntime): HttpClient {
  return runtime.client ?? new JinshujuHttpClient(loadConfig({ configPath: options.configPath, env: runtime.env, cli: { apiKey: options.apiKey, apiSecret: options.apiSecret } }));
}

async function authStatus(options: GlobalOptions, runtime: CliRuntime): Promise<CliResult> {
  const config = loadConfig({ configPath: options.configPath, env: runtime.env, cli: { apiKey: options.apiKey, apiSecret: options.apiSecret } });
  const authenticated = Boolean(config.apiKey && config.apiSecret);
  const payload = {
    authenticated,
    mode: 'api_key_secret',
    sources: config.sources,
    notes: 'API Key / Secret mode has no session; login/logout are reserved for OAuth.'
  };
  if (options.verify && authenticated) {
    await createClient(options, runtime).request({ method: 'GET', path: '/api/v1/forms' });
  }
  if (options.output === 'json') return ok(json(payload));
  return ok(authenticated ? 'Authenticated with API Key / Secret (no session).' : 'Missing API Key / Secret.');
}

function configGet(positionals: string[], options: GlobalOptions): CliResult {
  const requestedKey = positionals[2];
  if (requestedKey) assertConfigKey(requestedKey);
  const config = getConfig(options.configPath);
  const renderValue = (value: string | undefined) => options.showSecret ? value : maskSecret(value);
  let payload: Record<string, string | undefined>;
  if (requestedKey) {
    const configKey = requestedKey as ConfigKey;
    payload = { [configKey]: renderValue(config[configKey]) };
  } else {
    payload = { api_key: renderValue(config.api_key), api_secret: renderValue(config.api_secret) };
  }
  if (options.output === 'json') return ok(json(payload));
  return ok(Object.entries(payload).map(([k, v]) => `${k}: ${v ?? '(unset)'}`).join('\n'));
}

function configSet(positionals: string[], options: GlobalOptions): CliResult {
  const key = requireArg(positionals[2], 'key');
  assertConfigKey(key);
  const value = requireArg(positionals[3], 'value');
  setConfigValue(options.configPath, key, value);
  return ok(`Set ${key}`);
}

function configUnset(positionals: string[], options: GlobalOptions): CliResult {
  const key = requireArg(positionals[2], 'key');
  assertConfigKey(key);
  unsetConfigValue(options.configPath, key);
  return ok(`Unset ${key}`);
}

async function apiGet(path: string, options: GlobalOptions, runtime: CliRuntime): Promise<CliResult> {
  const result = await createClient(options, runtime).request({ method: 'GET', path });
  return ok(options.output === 'json' ? json(result) : text(result));
}

async function formCreate(options: GlobalOptions, runtime: CliRuntime): Promise<CliResult> {
  const payload = validateCreateFormPayload(parseJsonPayload(requireArg(options.jsonPayload, 'json')));
  const result = await createClient(options, runtime).request({ method: 'POST', path: '/api/v1/forms', body: payload });
  return ok(options.output === 'json' ? json(result) : text(result));
}

async function entryCreate(positionals: string[], options: GlobalOptions, runtime: CliRuntime): Promise<CliResult> {
  const formToken = requireArg(positionals[3], 'form-token');
  const payload = parseJsonPayload(requireArg(options.jsonPayload, 'json'));
  const result = await createClient(options, runtime).request({ method: 'POST', path: `/api/v1/forms/${formToken}/entries`, body: payload });
  return ok(options.output === 'json' ? json(result) : text(result));
}
