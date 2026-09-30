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
    summary: 'Log in through the browser, or with an access token, and store the credential',
    description:
      'Without --access-token: opens the authorization page, waits for the redirect on a loopback ' +
      'port, and writes the session to the config file. With it: checks the token with one call, ' +
      'then stores it; the OAuth options are ignored. Either replaces whatever credential was stored ' +
      'before. JINSHUJU_ACCESS_TOKEN, if set, still outranks what this stores.',
    options: local('--access-token', '--auth-host', '--client-id', '--scopes', '--no-open', '--host'),
    examples: ['jinshuju auth login', 'jinshuju auth login --no-open', 'jinshuju auth login --access-token <token>']
  },
  {
    path: ['auth', 'status'],
    summary: 'Show which credential is in use, and where it came from',
    description:
      'The precedence is JINSHUJU_ACCESS_TOKEN, then the credential `auth login` stored. ' +
      '--verify spends one call to confirm the credential still works, and reports the account it ' +
      'belongs to — with more than one configured, nothing else here says which is in play.',
    options: local('--verify', '--host', '--auth-host', '--client-id'),
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
    summary: 'Forget the stored credential, revoking it first if it is a browser session',
    description:
      'An access token cannot be revoked from here, only forgotten. JINSHUJU_ACCESS_TOKEN is not ' +
      "this command's to drop.",
    options: local('--auth-host', '--client-id')
  },
  {
    path: ['config', 'get'],
    summary: 'Read one configuration value',
    description: `Keys: ${CONFIG_KEYS.join(', ')}. Credentials are not config: \`auth login\` stores them.`,
    args: [{ name: 'key', required: true, description: `One of ${CONFIG_KEYS.join(', ')}` }],
    examples: ['jinshuju config get host']
  },
  {
    path: ['config', 'set'],
    summary: 'Write one configuration value',
    description:
      `Keys: ${CONFIG_KEYS.join(', ')}. The file is written with mode 600. JINSHUJU_HOST, ` +
      'JINSHUJU_AUTH_HOST and JINSHUJU_OAUTH_CLIENT_ID outrank whatever is stored here.',
    args: [
      { name: 'key', required: true, description: `One of ${CONFIG_KEYS.join(', ')}` },
      { name: 'value', required: true, description: 'The value to store' }
    ],
    examples: ['jinshuju config set host https://jinshuju.net']
  },
  {
    path: ['config', 'unset'],
    summary: 'Remove one configuration value',
    args: [{ name: 'key', required: true, description: `One of ${CONFIG_KEYS.join(', ')}` }],
    examples: ['jinshuju config unset host']
  }
];
