import { loginWithOAuth, refreshOAuthToken, revokeOAuthToken } from './auth.js';
import { bindOptions } from './args.js';
import {
  assertConfigKey,
  defaultConfigPath,
  getConfig,
  loadConfig,
  maskSecret,
  setConfigValue,
  unsetConfigValue,
  type ConfigKey
} from './config.js';
import { JinshujuHttpClient, type HttpClient } from './http.js';
import { GLOBAL_OPTIONS, LOCAL_OPTIONS, UsageError, type OutputFormat } from './options.js';
import { json } from './render.js';
import { ok, unknown, type CliResult, type CliRuntime } from './result.js';

/**
 * The commands that never reach the API: they read and write the config file,
 * or run a browser login. They are dispatched by name here rather than through
 * the command table, because what they do is not a request.
 */

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

export function localOptions(flags: Record<string, unknown>, stdin: () => string): LocalOptions {
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

export async function runLocal(
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
      return unknown(words, options.output);
  }
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw new UsageError(`Missing argument <${name}>`);
  return value;
}

function createClient(options: LocalOptions, runtime: CliRuntime): HttpClient {
  return (
    runtime.client ??
    new JinshujuHttpClient(
      loadConfig({
        configPath: options.configPath,
        env: runtime.env,
        cli: { apiKey: options.apiKey, apiSecret: options.apiSecret, host: options.host }
      })
    )
  );
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
  const payload = {
    authenticated: true,
    mode: 'oauth',
    auth_host: result.token.auth_host,
    client_id: result.token.client_id,
    scope: result.token.scope,
    expires_at: result.token.expires_at
  };
  if (options.output === 'json') return ok(json(payload));
  return ok(`Authenticated with OAuth.\nConfig: ${options.configPath}`);
}

async function authStatus(options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  const config = loadConfig({
    configPath: options.configPath,
    env: runtime.env,
    cli: {
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      host: options.host,
      authHost: options.authHost,
      clientId: options.clientId
    }
  });
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
    source:
      mode === 'access_token'
        ? config.sources.accessToken
        : mode === 'api_key_secret'
          ? config.sources.apiKey
          : mode === 'oauth'
            ? config.sources.auth
            : 'missing',
    oauth: config.auth
      ? {
          client_id: config.auth.client_id,
          scope: config.auth.scope,
          expires_at: config.auth.expires_at,
          has_refresh_token: Boolean(config.auth.refresh_token)
        }
      : undefined
  };
  if (options.verify && authenticated) {
    await createClient(options, runtime).request({ method: 'GET', path: '/api/v1/forms' });
  }
  if (options.output === 'json') return ok(json(payload));
  if (mode === 'access_token') return ok(`Authenticated with an access token (from ${config.sources.accessToken}).`);
  if (mode === 'oauth') return ok('Authenticated with OAuth.');
  if (mode === 'api_key_secret') return ok('Authenticated with API Key / Secret.');
  return ok(
    'Missing authentication. Run `jinshuju auth login`, or set an access token, or configure API Key / Secret.'
  );
}

async function authRefresh(options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  const config = loadConfig({
    configPath: options.configPath,
    env: runtime.env,
    cli: { host: options.host, authHost: options.authHost, clientId: options.clientId }
  });
  const auth = await refreshOAuthToken(config);
  if (options.output === 'json')
    return ok(json({ authenticated: true, mode: 'oauth', expires_at: auth.expires_at, scope: auth.scope }));
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
  return ok(
    Object.entries(payload)
      .map(([k, v]) => `${k}: ${v ?? '(unset)'}`)
      .join('\n')
  );
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
