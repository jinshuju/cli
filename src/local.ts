import {
  loginWithDevice,
  loginWithOAuth,
  logout,
  refreshOAuthToken,
  resumeDeviceLogin,
  startDeviceLogin
} from './auth.js';
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
  type ConfigKey,
  type OAuthConfig,
  type PendingDeviceLogin
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
  device: boolean;
  noWait: boolean;
  resume: boolean;
  timeout?: string;
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
    device: Boolean(bound.device),
    noWait: Boolean(bound.no_wait),
    resume: Boolean(bound.resume),
    timeout: bound.timeout as string | undefined,
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
      return unknown(words, options.output, runtime.terminal?.stderr);
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
  if (options.noWait && options.resume)
    throw new UsageError('--no-wait starts a device login and --resume finishes it; pick one');
  const target = {
    configPath: options.configPath,
    env: runtime.env,
    host: options.host,
    authHost: options.authHost,
    clientId: options.clientId,
    scopes: options.scopes
  };
  if (options.noWait) return pendingLogin(await startDeviceLogin(target), options);
  if (options.resume) return loggedIn(await resumeDeviceLogin({ ...target, waitMs: waitMs(options.timeout) }), options);
  if (options.device || (!options.noOpen && headless(runtime.env ?? process.env)))
    return loggedIn(await loginWithDevice(target, printDeviceCode), options);
  const result = await loginWithOAuth(target, options.noOpen ? printLoginUrl : undefined);
  return loggedIn(result.token, options);
}

function waitMs(seconds: string | undefined): number | undefined {
  if (seconds === undefined) return undefined;
  if (!/^\d+$/.test(seconds))
    throw new UsageError(`--timeout takes a whole number of seconds, got ${JSON.stringify(seconds)}`);
  return Number.parseInt(seconds, 10) * 1000;
}

/**
 * No browser could open here, or none that the person at the keyboard would
 * see: a session over SSH, or a Linux box without a display. The loopback
 * login would wait for a redirect that cannot arrive, so a device login is
 * the one that can work. --no-open still asks for the loopback login by name.
 */
function headless(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  return process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

function loggedIn(token: OAuthConfig, options: LocalOptions): CliResult {
  const payload = {
    authenticated: true,
    mode: 'oauth',
    auth_host: token.auth_host,
    client_id: token.client_id,
    scope: token.scope,
    expires_at: token.expires_at
  };
  if (options.output !== 'text') return ok(format(payload, options.output, 0));
  return ok(`Authenticated with OAuth.\nConfig: ${options.configPath}`);
}

/** The link and code go on stdout here: they are the result, and whoever ran this has to pass them on. */
function pendingLogin(pending: PendingDeviceLogin, options: LocalOptions): CliResult {
  const link = pending.verification_uri_complete ?? pending.verification_uri;
  const payload = {
    authenticated: false,
    pending: true,
    user_code: pending.user_code,
    verification_uri: pending.verification_uri,
    verification_uri_complete: pending.verification_uri_complete,
    expires_at: pending.expires_at,
    resume: 'jinshuju auth login --resume'
  };
  if (options.output !== 'text') return ok(format(payload, options.output, 0));
  return ok(
    `To log in, open ${link}\nand check it shows the code ${pending.user_code}, then approve it.\n` +
      `Then run \`jinshuju auth login --resume\` to finish. The code expires at ${pending.expires_at}.`
  );
}

/** While the login waits, so stdout still carries only the result. */
function printDeviceCode(pending: PendingDeviceLogin): void {
  const link = pending.verification_uri_complete ?? pending.verification_uri;
  process.stderr.write(
    `To log in, open this link on any device:\n${link}\n` +
      `and check it shows the code ${pending.user_code}, then approve it. Waiting…\n`
  );
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
