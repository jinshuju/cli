import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';

import { AuthError, PendingError, UsageError } from './errors.js';
import {
  clearCredential,
  defaultScopes,
  loadConfig,
  loadPendingDeviceLogin,
  saveOAuthConfig,
  saveOAuthLogin,
  savePendingDeviceLogin,
  type LoadConfigOptions,
  type LoadedConfig,
  type OAuthConfig,
  type PendingDeviceLogin
} from './config.js';

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

export type OAuthLoginOptions = LoadConfigOptions & {
  host?: string;
  authHost?: string;
  clientId?: string;
  scopes?: string;
  timeoutMs?: number;
  port?: number;
};

export type OAuthLoginResult = {
  authorizeUrl: string;
  callbackUrl: string;
  token: OAuthConfig;
};

export type BrowserOpener = (url: string) => Promise<void>;

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizationUrl(params: {
  authHost: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL('/oauth/authorize', params.authHost);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function loginWithOAuth(
  options: OAuthLoginOptions = {},
  opener: BrowserOpener = openUrl
): Promise<OAuthLoginResult> {
  const config = loadConfig({
    configPath: options.configPath,
    env: options.env,
    cli: { host: options.host, authHost: options.authHost, clientId: options.clientId }
  });
  const clientId = options.clientId ?? config.clientId;
  if (!clientId) throw new AuthError('Missing OAuth client id. Set JINSHUJU_OAUTH_CLIENT_ID or config client_id.');

  const state = base64Url(randomBytes(24));
  const { verifier, challenge } = createPkcePair();
  const scope = options.scopes ?? defaultScopes;
  const callback = await listenForOAuthCallback(state, options.port, options.timeoutMs ?? 120_000);
  const authorizeUrl = buildAuthorizationUrl({
    authHost: config.authHost,
    clientId,
    redirectUri: callback.redirectUri,
    scope,
    state,
    codeChallenge: challenge
  });

  // The callback can fail while the browser is still being opened — a forged
  // state, a refusal — and a rejection nobody is awaiting yet is reported as
  // unhandled. It is awaited right below; this only says so in the meantime.
  callback.code.catch(() => undefined);
  await opener(authorizeUrl);
  const code = await callback.code;
  const token = await exchangeAuthorizationCode(config.authHost, clientId, callback.redirectUri, code, verifier);
  const auth = toOAuthConfig(config, clientId, token);
  saveOAuthLogin(config.configPath, auth);
  return { authorizeUrl, callbackUrl: callback.redirectUri, token: auth };
}

export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export type DeviceLoginOptions = LoginTarget & {
  /** How to wait between polls; a test passes one that does not. */
  sleep?: (ms: number) => Promise<void>;
};

type LoginTarget = LoadConfigOptions & {
  host?: string;
  authHost?: string;
  clientId?: string;
  scopes?: string;
};

/**
 * RFC 8628. The CLI only ever calls out: it asks for a code, a person enters
 * it on whatever device has a browser — a phone will do — and the CLI polls
 * until they have approved it. Nothing has to reach back into this machine,
 * which is what a server over SSH or an agent's sandbox cannot offer the
 * loopback login.
 */
export async function loginWithDevice(
  options: DeviceLoginOptions,
  onCode: (pending: PendingDeviceLogin) => void
): Promise<OAuthConfig> {
  const { config, pending } = await requestDeviceCode(options);
  onCode(pending);
  return await finishDeviceLogin(config, pending, Date.parse(pending.expires_at), options.sleep);
}

/**
 * The first half of a device login, for a caller that cannot wait: an agent
 * whose commands are cut off after a minute or two. The code is stored, the
 * person is sent to approve it, and `resumeDeviceLogin` collects the session.
 */
export async function startDeviceLogin(options: LoginTarget): Promise<PendingDeviceLogin> {
  const { config, pending } = await requestDeviceCode(options);
  savePendingDeviceLogin(config.configPath, pending);
  return pending;
}

/** Waits up to `waitMs` for the stored device login to be approved; still waiting after that is a PendingError. */
export async function resumeDeviceLogin(options: DeviceLoginOptions & { waitMs?: number }): Promise<OAuthConfig> {
  const config = loadConfig({ configPath: options.configPath, env: options.env });
  const pending = loadPendingDeviceLogin(config.configPath);
  if (!pending) throw new UsageError('No device login is waiting. Start one with `jinshuju auth login --no-wait`.');
  const deadline = Math.min(Date.parse(pending.expires_at), Date.now() + (options.waitMs ?? 60_000));
  return await finishDeviceLogin(config, pending, deadline, options.sleep);
}

async function requestDeviceCode(options: LoginTarget): Promise<{ config: LoadedConfig; pending: PendingDeviceLogin }> {
  const config = loadConfig({
    configPath: options.configPath,
    env: options.env,
    cli: { host: options.host, authHost: options.authHost, clientId: options.clientId }
  });
  const clientId = options.clientId ?? config.clientId;
  if (!clientId) throw new AuthError('Missing OAuth client id. Set JINSHUJU_OAUTH_CLIENT_ID or config client_id.');

  const response = await fetch(new URL('/oauth/device_authorization', config.authHost), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, scope: options.scopes ?? defaultScopes }),
    signal: AbortSignal.timeout(config.timeoutMs ?? TOKEN_TIMEOUT_MS)
  });
  const body = parseTokenBody(await response.text(), response) as
    | (Partial<DeviceAuthorizationResponse> & { error?: string; error_description?: string })
    | undefined;
  if (!response.ok || !body?.device_code || !body.user_code || !body.verification_uri) {
    throw new AuthError(
      body?.error_description ??
        body?.error ??
        `${response.status} ${response.statusText} from the device authorization endpoint`.trim()
    );
  }
  return {
    config,
    pending: {
      auth_host: config.authHost,
      client_id: clientId,
      device_code: body.device_code,
      user_code: body.user_code,
      verification_uri: body.verification_uri,
      verification_uri_complete: body.verification_uri_complete,
      interval: body.interval ?? 5,
      expires_at: new Date(Date.now() + (body.expires_in ?? 900) * 1000).toISOString()
    }
  };
}

type DeviceAuthorizationResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

/**
 * Polls at the interval the server asked for, five seconds slower each time it
 * says `slow_down`, as RFC 8628 has it. A refusal or an expired code ends the
 * login; running out of `deadline` while the code is still good does not, it
 * only stops this wait.
 */
async function finishDeviceLogin(
  config: LoadedConfig,
  pending: PendingDeviceLogin,
  deadline: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<OAuthConfig> {
  let interval = pending.interval;
  const outOfTime = () => {
    if (deadline >= Date.parse(pending.expires_at))
      return new AuthError('The login code expired before it was approved. Start a new login.');
    return new PendingError(
      `Still waiting for the code ${pending.user_code} to be approved at ` +
        `${pending.verification_uri_complete ?? pending.verification_uri}. Run \`jinshuju auth login --resume\` again.`
    );
  };
  // The first poll is always made, so `--timeout 0` asks once rather than not at all.
  let first = true;
  for (;;) {
    const remaining = deadline - Date.now();
    const answer = await pollDeviceToken(
      pending,
      config.timeoutMs ?? TOKEN_TIMEOUT_MS,
      first && remaining <= 0 ? Number.POSITIVE_INFINITY : remaining
    );
    first = false;
    if ('outOfTime' in answer) throw outOfTime();
    if ('token' in answer) {
      const auth = toOAuthConfig({ ...config, authHost: pending.auth_host }, pending.client_id, answer.token);
      saveOAuthLogin(config.configPath, auth);
      return auth;
    }
    if (answer.error === 'slow_down') interval += 5;
    else if (answer.error === 'access_denied') throw new AuthError('The login was refused on the authorization page.');
    else if (answer.error === 'expired_token' || answer.error === 'invalid_grant')
      throw new AuthError('The login code expired before it was approved. Start a new login.');
    else if (answer.error !== 'authorization_pending') throw new AuthError(answer.description ?? answer.error);

    if (Date.now() + interval * 1000 >= deadline) throw outOfTime();
    await sleep(interval * 1000);
  }
}

/**
 * One poll, held to the time the login has left as well as to its own
 * timeout: a request still in flight when the --timeout runs out is abandoned,
 * as `outOfTime`, rather than holding the command past what its caller allowed.
 */
async function pollDeviceToken(
  pending: PendingDeviceLogin,
  timeoutMs: number,
  remainingMs: number
): Promise<{ token: TokenResponse } | { error: string; description?: string } | { outOfTime: true }> {
  if (remainingMs <= 0) return { outOfTime: true };
  let response: Response;
  try {
    response = await fetch(new URL('/oauth/token', pending.auth_host), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: pending.client_id,
        device_code: pending.device_code
      }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, remainingMs))
    });
  } catch (error) {
    if ((error as Error).name === 'TimeoutError' && remainingMs <= timeoutMs) return { outOfTime: true };
    throw error;
  }
  const body = parseTokenBody(await response.text(), response);
  if (response.ok && body?.access_token) return { token: body as TokenResponse };
  return {
    error: body?.error ?? `${response.status} ${response.statusText}`.trim(),
    description: body?.error_description
  };
}

export async function refreshOAuthToken(config: LoadedConfig): Promise<OAuthConfig> {
  if (!config.auth?.refresh_token) throw new AuthError('No OAuth refresh token. Run `jinshuju auth login` again.');
  const token = await tokenRequest(
    config.auth.auth_host,
    {
      grant_type: 'refresh_token',
      client_id: config.auth.client_id,
      refresh_token: config.auth.refresh_token
    },
    config.timeoutMs
  );
  const auth = toOAuthConfig(config, config.auth.client_id, token, config.auth);
  saveOAuthConfig(config.configPath, auth);
  return auth;
}

/**
 * Revokes a stored OAuth session, then forgets whatever credential is stored.
 * An access token has no revoke endpoint here; it is only forgotten.
 */
export async function logout(config: LoadedConfig): Promise<void> {
  if (config.auth?.access_token) {
    const url = new URL('/oauth/revoke', config.auth.auth_host);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: config.auth.client_id, token: config.auth.access_token }),
      signal: AbortSignal.timeout(config.timeoutMs ?? TOKEN_TIMEOUT_MS)
    }).catch(() => undefined);
  }
  clearCredential(config.configPath);
}

export function shouldRefresh(auth: OAuthConfig, skewMs = 60_000): boolean {
  if (!auth.expires_at) return false;
  return Date.parse(auth.expires_at) - skewMs <= Date.now();
}

async function exchangeAuthorizationCode(
  authHost: string,
  clientId: string,
  redirectUri: string,
  code: string,
  codeVerifier: string
): Promise<TokenResponse> {
  return tokenRequest(authHost, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });
}

/**
 * A token endpoint that answers with something other than JSON — a login page,
 * a gateway's error — is reported as the status it sent. Parsing first turned
 * that into "Unexpected token '<'" with the status nowhere to be seen.
 */
function parseTokenBody(
  text: string,
  response: Response
): { access_token?: string; error?: string; error_description?: string } | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as { access_token?: string; error?: string; error_description?: string };
  } catch {
    const flat = text.replace(/\s+/g, ' ').trim();
    throw new AuthError(
      `${response.status} ${response.statusText} from the token endpoint, and the body is not JSON: ` +
        (flat.length <= 120 ? flat : `${flat.slice(0, 120)}…`)
    );
  }
}

/** A token endpoint answers at once or not at all; a minute is generous. */
const TOKEN_TIMEOUT_MS = 60_000;

async function tokenRequest(
  authHost: string,
  params: Record<string, string>,
  timeoutMs = TOKEN_TIMEOUT_MS
): Promise<TokenResponse> {
  const url = new URL('/oauth/token', authHost);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const body = parseTokenBody(text, response);
  if (!response.ok) {
    throw new AuthError(body?.error_description ?? body?.error ?? `${response.status} ${response.statusText}`.trim());
  }
  if (!body?.access_token) throw new AuthError('OAuth token response is missing access_token');
  return body as TokenResponse;
}

function toOAuthConfig(
  config: LoadedConfig,
  clientId: string,
  token: TokenResponse,
  previous?: OAuthConfig
): OAuthConfig {
  return {
    type: 'oauth',
    auth_host: previous?.auth_host ?? config.authHost,
    client_id: clientId,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? previous?.refresh_token,
    expires_at: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : previous?.expires_at,
    scope: token.scope ?? previous?.scope
  };
}

function listenForOAuthCallback(
  expectedState: string,
  port = 0,
  timeoutMs = 120_000
): Promise<{ redirectUri: string; code: Promise<string> }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      const error = url.searchParams.get('error') ?? '';
      if (!safeEqual(state, expectedState)) {
        res.writeHead(400).end('Invalid OAuth state. You can close this tab.');
        callbackReject(new Error('Invalid OAuth state'));
        return;
      }
      if (error) {
        res.writeHead(400).end('OAuth authorization failed. You can close this tab.');
        callbackReject(new Error(error));
        return;
      }
      if (!code) {
        res.writeHead(400).end('Missing OAuth code. You can close this tab.');
        callbackReject(new Error('Missing OAuth code'));
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Jinshuju CLI login complete. You can close this tab.');
      callbackResolve(code);
    });

    let callbackResolve: (code: string) => void;
    let callbackReject: (error: Error) => void;
    const code = new Promise<string>((resolveCode, rejectCode) => {
      callbackResolve = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        resolveCode(value);
      };
      callbackReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        rejectCode(error);
      };
    });
    const timer = setTimeout(() => callbackReject(new Error('OAuth login timed out')), timeoutMs);
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to open OAuth callback server'));
        return;
      }
      resolve({ redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`, code });
    });
  });
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

/**
 * A browser that cannot be opened — no xdg-open on a server, no display —
 * says so with the URL, rather than leaving the login to wait out its timeout
 * in silence for a page nobody will ever see.
 */
async function openUrl(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const opened = await new Promise<boolean>((resolve) => execFile(command, args, (error) => resolve(!error)));
  if (!opened)
    process.stderr.write(
      `Could not open a browser. Open this URL to log in:\n${url}\n` +
        'Without a browser on this machine, `jinshuju auth login --device` logs in from another device instead.\n'
    );
}
