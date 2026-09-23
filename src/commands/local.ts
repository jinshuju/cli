import { LOCAL_OPTIONS, type OptionSpec } from '../options.js';
import type { Command } from './types.js';
import { CONFIG_KEYS } from '../config.js';

/** The local options a command takes, by flag name. */
function local(...names: string[]): readonly OptionSpec[] {
  return names.map((name) => {
    const spec = LOCAL_OPTIONS.find((candidate) => candidate.name === name);
    if (!spec) throw new Error(`no local option ${name}`);
    return spec;
  });
}

/**
 * The commands that never reach the API: they read and write the config file,
 * or run a browser login. `cli.ts` dispatches them itself, so they carry no
 * request — but they belong in this table all the same, because help is
 * rendered from it. Left out, `auth login --help` answered with the root
 * listing and `--no-open`, `--verify` and `--show-secret` were documented
 * nowhere a caller could reach.
 */
export const LOCAL: readonly Command[] = [
  {
    path: ['auth', 'login'],
    summary: 'Log in through the browser and store the session',
    description:
      'Opens the authorization page, waits for the redirect on a loopback port, and writes the ' +
      'session to the config file. An access token or an API key pair, if configured, still ' +
      'outranks what this stores.',
    options: local('--auth-host', '--client-id', '--scopes', '--no-open', '--host'),
    examples: ['jinshuju auth login', 'jinshuju auth login --no-open']
  },
  {
    path: ['auth', 'status'],
    summary: 'Show which credential is in use, and where it came from',
    description:
      'The precedence is access token, then API key and secret, then a stored browser login. ' +
      '--verify spends one lightweight call to confirm the credential still works.',
    options: local('--verify', '--api-key', '--api-secret', '--host', '--auth-host', '--client-id'),
    examples: ['jinshuju auth status', 'jinshuju auth status --verify']
  },
  {
    path: ['auth', 'refresh'],
    summary: 'Renew the stored browser session',
    description:
      'Only an OAuth session can be refreshed; a token that stopped working has to be replaced by whoever issued it.',
    options: local('--auth-host', '--client-id')
  },
  {
    path: ['auth', 'logout'],
    summary: 'Revoke the stored browser session and forget it',
    description: "Leaves an access token or API key pair in the config alone: those are not this command's to drop.",
    options: local('--auth-host', '--client-id')
  },
  {
    path: ['config', 'get'],
    summary: 'Read one configuration value',
    description: `Keys: ${CONFIG_KEYS.join(', ')}. Secrets are masked unless --show-secret says otherwise.`,
    args: [{ name: 'key', required: true, description: `One of ${CONFIG_KEYS.join(', ')}` }],
    options: local('--show-secret'),
    examples: ['jinshuju config get api_key', 'jinshuju config get access_token --show-secret']
  },
  {
    path: ['config', 'set'],
    summary: 'Write one configuration value',
    description:
      `Keys: ${CONFIG_KEYS.join(', ')}. The file is written with mode 600. Environment variables ` +
      'of the same name (JINSHUJU_ACCESS_TOKEN, JINSHUJU_API_KEY, …) outrank whatever is stored here.',
    args: [
      { name: 'key', required: true, description: `One of ${CONFIG_KEYS.join(', ')}` },
      { name: 'value', required: true, description: 'The value to store' }
    ],
    examples: ['jinshuju config set access_token xxx', 'jinshuju config set host https://jinshuju.net']
  },
  {
    path: ['config', 'unset'],
    summary: 'Remove one configuration value',
    args: [{ name: 'key', required: true, description: `One of ${CONFIG_KEYS.join(', ')}` }],
    examples: ['jinshuju config unset api_secret']
  }
];
