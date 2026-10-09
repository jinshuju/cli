import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { UsageError } from './errors.js';

export type ConfigKey = 'host' | 'auth_host' | 'client_id';
export type ConfigSource = 'cli' | 'env' | 'file' | 'missing';

export type OAuthConfig = {
  type: 'oauth';
  auth_host: string;
  client_id: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope?: string;
};

/** An access token stored by `auth login --access-token`. It takes the same slot as an OAuth session. */
export type TokenConfig = {
  type: 'access_token';
  access_token: string;
};

export type LoadedConfig = {
  /**
   * A personal or account access token, sent as a bearer: JINSHUJU_ACCESS_TOKEN,
   * or the one `auth login --access-token` stored.
   */
  accessToken?: string;
  host: string;
  authHost: string;
  clientId?: string;
  auth?: OAuthConfig;
  /** How long one request may take, from JINSHUJU_TIMEOUT_MS; unset means the client's default. */
  timeoutMs?: number;
  configPath: string;
  sources: {
    accessToken: ConfigSource;
    host: ConfigSource;
    authHost: ConfigSource;
    clientId: ConfigSource;
    auth: ConfigSource;
  };
};

export type LoadConfigOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cli?: {
    host?: string;
    authHost?: string;
    clientId?: string;
  };
};

export const defaultConfigPath = join(homedir(), '.jinshuju', 'config.json');
export const defaultHost = 'https://jinshuju.net';
export const defaultAuthHost = 'https://account.jinshuju.net';
export const defaultOAuthClientId = 'jinshuju_cli_public';
export const defaultScopes = 'public forms read_entries write_entries form_setting read_contacts users routines';

/**
 * One credential at a time: a login of either kind replaces whatever the last
 * one stored, so the file never holds two that disagree about who is calling.
 */
export type RawConfig = Partial<Record<ConfigKey, string>> & { auth?: OAuthConfig | TokenConfig };

function readConfigFile(configPath: string): RawConfig {
  if (!existsSync(configPath)) return {};
  const text = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `${configPath} is not valid JSON: ${(error as Error).message}. Fix it, or remove it and log in again.`,
      {
        cause: error
      }
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(
      `${configPath} should hold a JSON object, not ${Array.isArray(parsed) ? 'a list' : String(parsed)}`
    );
  }
  return parsed as RawConfig;
}

/**
 * Written whole or not at all: the file goes down beside its target and is
 * renamed over it, so a crash mid-write, or two commands refreshing a token at
 * once, cannot leave half a file behind. The mode is set every time, because
 * the mode on writeFileSync only applies to a file that did not exist yet.
 */
function writeConfigFile(configPath: string, config: RawConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const draft = `${configPath}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(draft, 0o600);
  renameSync(draft, configPath);
}

function pickValue(
  cliValue: string | undefined,
  envValue: string | undefined,
  fileValue: string | undefined,
  fallback?: string
): { value: string; source: ConfigSource };
function pickValue(
  cliValue: string | undefined,
  envValue: string | undefined,
  fileValue: string | undefined
): { value?: string; source: ConfigSource };
function pickValue(
  cliValue: string | undefined,
  envValue: string | undefined,
  fileValue: string | undefined,
  fallback?: string
): { value?: string; source: ConfigSource } {
  if (cliValue) return { value: cliValue, source: 'cli' };
  if (envValue) return { value: envValue, source: 'env' };
  if (fileValue) return { value: fileValue, source: 'file' };
  if (fallback) return { value: fallback, source: 'missing' };
  return { source: 'missing' };
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const configPath = options.configPath ?? defaultConfigPath;
  const env = options.env ?? process.env;
  const file = readConfigFile(configPath);
  const auth = file.auth?.type === 'oauth' ? file.auth : undefined;
  const storedToken = file.auth?.type === 'access_token' ? file.auth.access_token : undefined;
  const accessToken = pickValue(undefined, env.JINSHUJU_ACCESS_TOKEN, storedToken);
  const host = pickValue(options.cli?.host, env.JINSHUJU_HOST, file.host, defaultHost);
  const authHost = pickValue(
    options.cli?.authHost,
    env.JINSHUJU_AUTH_HOST,
    file.auth_host ?? auth?.auth_host,
    defaultAuthHost
  );
  const defaultClientId = authHost.value === defaultAuthHost ? defaultOAuthClientId : undefined;
  const clientId = pickValue(
    options.cli?.clientId,
    env.JINSHUJU_OAUTH_CLIENT_ID,
    file.client_id ?? auth?.client_id,
    defaultClientId
  );
  const timeoutMs = parseTimeout(env.JINSHUJU_TIMEOUT_MS);

  return {
    accessToken: accessToken.value,
    host: host.value,
    authHost: authHost.value,
    clientId: clientId.value,
    auth,
    timeoutMs,
    configPath,
    sources: {
      accessToken: accessToken.source,
      host: host.source,
      authHost: authHost.source,
      clientId: clientId.source,
      auth: auth ? 'file' : 'missing'
    }
  };
}

/** A whole number of milliseconds, or nothing: a timeout nobody can parse is not a timeout of zero. */
function parseTimeout(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value))
    throw new UsageError(`JINSHUJU_TIMEOUT_MS must be a whole number of milliseconds, got ${JSON.stringify(value)}`);
  return Number.parseInt(value, 10);
}

export function setConfigValue(configPath: string, key: ConfigKey, value: string): void {
  const config = readConfigFile(configPath);
  config[key] = value;
  writeConfigFile(configPath, config);
}

export function unsetConfigValue(configPath: string, key: ConfigKey): void {
  const config = readConfigFile(configPath);
  delete config[key];
  writeConfigFile(configPath, config);
}

export function saveOAuthConfig(configPath: string, auth: OAuthConfig): void {
  const config = readConfigFile(configPath);
  config.auth = auth;
  config.auth_host = auth.auth_host;
  config.client_id = auth.client_id;
  writeConfigFile(configPath, config);
}

export function saveAccessToken(configPath: string, accessToken: string): void {
  const config = readConfigFile(configPath);
  config.auth = { type: 'access_token', access_token: accessToken };
  writeConfigFile(configPath, config);
}

/** Forgets the stored credential, whichever kind it is. */
export function clearCredential(configPath: string): void {
  const config = readConfigFile(configPath);
  delete config.auth;
  writeConfigFile(configPath, config);
}

export function getConfig(configPath: string): RawConfig {
  return readConfigFile(configPath);
}

/** Every key the config file holds, in the order help should list them. */
export const CONFIG_KEYS: readonly ConfigKey[] = ['host', 'auth_host', 'client_id'];

export function assertConfigKey(value: string): asserts value is ConfigKey {
  if (!(CONFIG_KEYS as readonly string[]).includes(value)) {
    throw new UsageError(`Config key must be one of ${CONFIG_KEYS.join(', ')}`);
  }
}
