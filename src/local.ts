import { loginWithOAuth, logout, refreshOAuthToken } from './auth.js';
import { bindOptions } from './args.js';
import {
  assertConfigKey,
  CONFIG_KEYS,
  defaultConfigPath,
  getConfig,
  loadConfig,
  saveAccessToken,
  setConfigValue,
  unsetConfigValue,
  type ConfigKey
} from './config.js';
import { AuthError } from './errors.js';
import { JinshujuHttpClient, type HttpClient } from './http.js';
import { GLOBAL_OPTIONS, LOCAL_OPTIONS, UsageError, type OutputFormat } from './options.js';
import { format } from './render.js';
import { ok, unknown, type CliResult, type CliRuntime } from './result.js';
import { isRecord } from './values.js';

/**
 * The commands that never reach the API: they read and write the config file,
 * or run a browser login. They are dispatched by name here rather than through
 * the command table, because what they do is not a request.
 */

/** Everything the local (auth, config) commands read off the command line. */
type LocalOptions = {
  output: OutputFormat;
  configPath: string;
  accessToken?: string;
  host?: string;
  authHost?: string;
  clientId?: string;
  scopes?: string;
  noOpen: boolean;
  verify: boolean;
};

export function localOptions(flags: Record<string, unknown>, stdin: () => string): LocalOptions {
  const bound = bindOptions([...GLOBAL_OPTIONS, ...LOCAL_OPTIONS], flags, 'this command', stdin);
  return {
    output: (bound.output as OutputFormat) ?? 'text',
    configPath: (bound.config as string) ?? defaultConfigPath,
    accessToken: bound.access_token as string | undefined,
    host: bound.host as string | undefined,
    authHost: bound.auth_host as string | undefined,
    clientId: bound.client_id as string | undefined,
    scopes: bound.scopes as string | undefined,
    noOpen: Boolean(bound.no_open),
    verify: Boolean(bound.verify)
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

/** A client that sends `accessToken` when one is given, and the configured credential otherwise. */
function createClient(options: LocalOptions, runtime: CliRuntime, accessToken?: string): HttpClient {
  if (runtime.client) return runtime.client;
  const config = loadConfig({ configPath: options.configPath, env: runtime.env, cli: { host: options.host } });
  return new JinshujuHttpClient(accessToken ? { ...config, accessToken } : config);
}

async function authLogin(options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  if (options.accessToken !== undefined) return await tokenLogin(options.accessToken, options, runtime);
  const result = await loginWithOAuth(
    {
      configPath: options.configPath,
      env: runtime.env,
      host: options.host,
      authHost: options.authHost,
      clientId: options.clientId,
      scopes: options.scopes
    },
    options.noOpen ? printLoginUrl : undefined
  );
  const payload = {
    authenticated: true,
    mode: 'oauth',
    auth_host: result.token.auth_host,
    client_id: result.token.client_id,
    scope: result.token.scope,
    expires_at: result.token.expires_at
  };
  if (options.output !== 'text') return ok(format(payload, options.output, 0));
  return ok(`Authenticated with OAuth.\nConfig: ${options.configPath}`);
}

/**
 * A token is checked before it is stored: one pasted wrong would otherwise sit
 * in the config until the next command failed with it, far from where it was
 * typed. The same call says whose token it is.
 */
/** --no-open: the URL goes to stderr, so stdout still carries only the result. */
async function printLoginUrl(url: string): Promise<void> {
  process.stderr.write(`Open this URL in a browser to log in:\n${url}\n`);
}

async function tokenLogin(accessToken: string, options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  if (!accessToken) throw new UsageError('--access-token needs a token');
  const account = await identify(createClient(options, runtime, accessToken));
  saveAccessToken(options.configPath, accessToken);
  if (options.output !== 'text')
    return ok(format({ authenticated: true, mode: 'access_token', account }, options.output, 0));
  return ok(`Authenticated with an access token.${describeAccount(account)}\nConfig: ${options.configPath}`);
}

async function authStatus(options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  const config = loadConfig({
    configPath: options.configPath,
    env: runtime.env,
    cli: { host: options.host, authHost: options.authHost, clientId: options.clientId }
  });
  const authenticated = Boolean(config.accessToken || config.auth?.access_token);
  const mode = config.accessToken ? 'access_token' : config.auth?.access_token ? 'oauth' : 'none';
  const payload = {
    authenticated,
    mode,
    host: config.host,
    auth_host: config.authHost,
    sources: config.sources,
    source: mode === 'access_token' ? config.sources.accessToken : mode === 'oauth' ? config.sources.auth : 'missing',
    oauth: config.auth
      ? {
          client_id: config.auth.client_id,
          scope: config.auth.scope,
          expires_at: config.auth.expires_at,
          has_refresh_token: Boolean(config.auth.refresh_token)
        }
      : undefined
  };
  // The call --verify already spends is enough to say *whose* credential this
  // is, which is the question behind asking. Swapping tokens changes nothing in
  // this output otherwise, and a caller with two accounts cannot tell which one
  // it is about to write to.
  const account = options.verify && authenticated ? await identify(createClient(options, runtime)) : undefined;
  const full = { ...payload, ...(account ? { account } : {}) };

  if (options.output !== 'text') return ok(format(full, options.output, 0));

  const whose = describeAccount(account);
  if (mode === 'access_token')
    return ok(`Authenticated with an access token (from ${config.sources.accessToken}).${whose}`);
  if (mode === 'oauth') return ok(`Authenticated with OAuth.${whose}`);
  return ok(
    'Missing authentication. Run `jinshuju auth login` or `jinshuju auth login --access-token <token>`, ' +
      'or set JINSHUJU_ACCESS_TOKEN.'
  );
}

function describeAccount(account: { name?: string; plan?: string } | undefined): string {
  return account ? ` Account: ${account.name}${account.plan ? ` (${account.plan})` : ''}.` : '';
}

/**
 * Who the credential belongs to. Reading the account proves the credential works
 * — which is all --verify used to do with it — and answers the question that
 * makes anyone ask: with two accounts configured, which one is this?
 */
async function identify(client: HttpClient): Promise<{ id?: string; name?: string; plan?: string }> {
  const body = await client.request<Record<string, unknown>>({ method: 'GET', path: '/api/v1/billing_account' });
  const plan = isRecord(body.plan) ? body.plan.name : undefined;
  return {
    id: typeof body.id === 'string' ? body.id : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    plan: typeof plan === 'string' ? plan : undefined
  };
}

async function authRefresh(options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  const config = loadConfig({
    configPath: options.configPath,
    env: runtime.env,
    cli: { host: options.host, authHost: options.authHost, clientId: options.clientId }
  });
  if (!config.auth && config.accessToken)
    throw new AuthError('An access token cannot be refreshed; log in again with a new one if it stopped working.');
  const auth = await refreshOAuthToken(config);
  if (options.output !== 'text')
    return ok(
      format({ authenticated: true, mode: 'oauth', expires_at: auth.expires_at, scope: auth.scope }, options.output, 0)
    );
  return ok('OAuth token refreshed.');
}

async function authLogout(options: LocalOptions, runtime: CliRuntime): Promise<CliResult> {
  const config = loadConfig({ configPath: options.configPath, env: runtime.env });
  await logout(config);
  return ok(options.output !== 'text' ? format({ authenticated: false }, options.output, 0) : 'Logged out.');
}

function configGet(positionals: readonly string[], options: LocalOptions): CliResult {
  const requestedKey = positionals[2];
  if (requestedKey) assertConfigKey(requestedKey);
  const config = getConfig(options.configPath);
  const keys = requestedKey ? [requestedKey as ConfigKey] : CONFIG_KEYS;
  const payload = Object.fromEntries(keys.map((key) => [key, config[key]]));
  if (options.output !== 'text') return ok(format(payload, options.output, 0));
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
