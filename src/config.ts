import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type ConfigKey = 'api_key' | 'api_secret';
export type ConfigSource = 'cli' | 'env' | 'file' | 'missing';

export type LoadedConfig = {
  apiKey?: string;
  apiSecret?: string;
  configPath: string;
  sources: {
    apiKey: ConfigSource;
    apiSecret: ConfigSource;
  };
};

export type LoadConfigOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cli?: {
    apiKey?: string;
    apiSecret?: string;
  };
};

export const defaultConfigPath = join(homedir(), '.jinshuju', 'config.json');

type RawConfig = Partial<Record<ConfigKey, string>>;

function readConfigFile(configPath: string): RawConfig {
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf8')) as RawConfig;
}

function writeConfigFile(configPath: string, config: RawConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function pickValue(cliValue: string | undefined, envValue: string | undefined, fileValue: string | undefined): { value?: string; source: ConfigSource } {
  if (cliValue) return { value: cliValue, source: 'cli' };
  if (envValue) return { value: envValue, source: 'env' };
  if (fileValue) return { value: fileValue, source: 'file' };
  return { source: 'missing' };
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const configPath = options.configPath ?? defaultConfigPath;
  const env = options.env ?? process.env;
  const file = readConfigFile(configPath);
  const apiKey = pickValue(options.cli?.apiKey, env.JINSHUJU_API_KEY, file.api_key);
  const apiSecret = pickValue(options.cli?.apiSecret, env.JINSHUJU_API_SECRET, file.api_secret);

  return {
    apiKey: apiKey.value,
    apiSecret: apiSecret.value,
    configPath,
    sources: {
      apiKey: apiKey.source,
      apiSecret: apiSecret.source
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

export function getConfig(configPath: string): RawConfig {
  return readConfigFile(configPath);
}

export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function assertConfigKey(value: string): asserts value is ConfigKey {
  if (value !== 'api_key' && value !== 'api_secret') {
    throw new Error('Config key must be api_key or api_secret');
  }
}
