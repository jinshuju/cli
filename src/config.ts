import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type ConfigKey = 'access_token' | 'api_key' | 'api_secret' | 'host' | 'auth_host' | 'client_id';
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

export type LoadedConfig = {
  /**
   * A personal or account access token, sent as a bearer. Goldendata accepts it
   * on API v1 alongside the API key pair and an OAuth session.
   */
  accessToken?: string;
  apiKey?: string;
  apiSecret?: string;
  host: string;
  authHost: string;
  clientId?: string;
  auth?: OAuthConfig;
  configPath: string;
  sources: {
    accessToken: ConfigSource;
    apiKey: ConfigSource;
    apiSecret: ConfigSource;
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
    accessToken?: string;
    apiKey?: string;
    apiSecret?: string;
    host?: string;
    authHost?: string;
    clientId?: string;
  };
};

export const defaultConfigPath = join(homedir(), '.jinshuju', 'config.json');
export const defaultHost = 'https://jinshuju.net';
export const defaultAuthHost = 'https://account.jinshuju.net';
export const defaultOAuthClientId = 'jinshuju_cli_public';
export const defaultScopes = 'public forms read_entries write_entries form_setting read_contacts users';

export type RawConfig = Partial<Record<ConfigKey, string>> & { auth?: OAuthConfig };

function readConfigFile(configPath: string): RawConfig {
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf8')) as RawConfig;
}

function writeConfigFile(configPath: string, config: RawConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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
  const accessToken = pickValue(options.cli?.accessToken, env.JINSHUJU_ACCESS_TOKEN, file.access_token);
  const apiKey = pickValue(options.cli?.apiKey, env.JINSHUJU_API_KEY, file.api_key);
  const apiSecret = pickValue(options.cli?.apiSecret, env.JINSHUJU_API_SECRET, file.api_secret);
  const host = pickValue(options.cli?.host, env.JINSHUJU_HOST, file.host, defaultHost);
  const authHost = pickValue(
    options.cli?.authHost,
    env.JINSHUJU_AUTH_HOST,
    file.auth_host ?? file.auth?.auth_host,
    defaultAuthHost
  );
  const defaultClientId = authHost.value === defaultAuthHost ? defaultOAuthClientId : undefined;
  const clientId = pickValue(
    options.cli?.clientId,
    env.JINSHUJU_OAUTH_CLIENT_ID,
    file.client_id ?? file.auth?.client_id,
    defaultClientId
  );
  const auth = file.auth?.type === 'oauth' ? file.auth : undefined;

  return {
    accessToken: accessToken.value,
    apiKey: apiKey.value,
    apiSecret: apiSecret.value,
    host: host.value,
    authHost: authHost.value,
    clientId: clientId.value,
    auth,
    configPath,
    sources: {
      accessToken: accessToken.source,
      apiKey: apiKey.source,
      apiSecret: apiSecret.source,
      host: host.source,
      authHost: authHost.source,
      clientId: clientId.source,
      auth: auth ? 'file' : 'missing'
    }
  };
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

export function clearOAuthConfig(configPath: string): void {
  const config = readConfigFile(configPath);
  delete config.auth;
  writeConfigFile(configPath, config);
}

export function getConfig(configPath: string): RawConfig {
  return readConfigFile(configPath);
}

export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Every key the config file holds, in the order help should list them. */
export const CONFIG_KEYS: readonly ConfigKey[] = [
  'access_token',
  'api_key',
  'api_secret',
  'host',
  'auth_host',
  'client_id'
];

export function assertConfigKey(value: string): asserts value is ConfigKey {
  if (!(CONFIG_KEYS as readonly string[]).includes(value)) {
    throw new Error(`Config key must be one of ${CONFIG_KEYS.join(', ')}`);
  }
}
