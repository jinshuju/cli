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

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
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
        return authStatus(parsed.options, runtime);
      case 'config get':
        return configGet(parsed.positionals, parsed.options);
      case 'config set':
        return configSet(parsed.positionals, parsed.options);
      case 'config unset':
        return configUnset(parsed.positionals, parsed.options);
      case 'form list':
        return apiGet('/api/v1/forms', parsed.options, runtime, 'Forms');
      case 'form get':
        return apiGet(`/api/v1/forms/${requireArg(parsed.positionals[2], 'form-token')}`, parsed.options, runtime, 'Form');
      case 'form create':
        return await formCreate(parsed.options, runtime);
      case 'form entry list':
        return apiGet(`/api/v1/forms/${requireArg(parsed.positionals[3], 'form-token')}/entries`, parsed.options, runtime, 'Entries');
      case 'form entry get':
        return apiGet(`/api/v1/forms/${requireArg(parsed.positionals[3], 'form-token')}/entries/${requireArg(parsed.positionals[4], 'entry-serial-number')}`, parsed.options, runtime, 'Entry');
      case 'form entry create':
        return await entryCreate(parsed.positionals, parsed.options, runtime);
      case 'form view list':
        return apiGet(`/api/v1/forms/${requireArg(parsed.positionals[3], 'form-token')}/views`, parsed.options, runtime, 'Views');
      case 'form view get':
        return apiGet(`/api/v1/forms/${requireArg(parsed.positionals[3], 'form-token')}/views/${requireArg(parsed.positionals[4], 'view-token')}`, parsed.options, runtime, 'View');
      case 'form view entry list':
        return apiGet(`/api/v1/forms/${requireArg(parsed.positionals[4], 'form-token')}/views/${requireArg(parsed.positionals[5], 'view-token')}/entries`, parsed.options, runtime, 'Entries');
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

async function apiGet(path: string, options: GlobalOptions, runtime: CliRuntime, label: string): Promise<CliResult> {
  const result = await createClient(options, runtime).request({ method: 'GET', path });
  if (options.output === 'json') return ok(json(result));
  return ok(`${label} fetched`);
}

async function formCreate(options: GlobalOptions, runtime: CliRuntime): Promise<CliResult> {
  const payload = validateCreateFormPayload(parseJsonPayload(requireArg(options.jsonPayload, 'json')));
  const result = await createClient(options, runtime).request({ method: 'POST', path: '/api/v1/forms', body: payload });
  if (options.output === 'json') return ok(json(result));
  return ok('Form created');
}

async function entryCreate(positionals: string[], options: GlobalOptions, runtime: CliRuntime): Promise<CliResult> {
  const formToken = requireArg(positionals[3], 'form-token');
  const payload = parseJsonPayload(requireArg(options.jsonPayload, 'json'));
  const result = await createClient(options, runtime).request({ method: 'POST', path: `/api/v1/forms/${formToken}/entries`, body: payload });
  if (options.output === 'json') return ok(json(result));
  return ok('Entry created');
}
