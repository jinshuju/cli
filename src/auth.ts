import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';

import { clearOAuthConfig, defaultScopes, loadConfig, saveOAuthConfig, type LoadConfigOptions, type LoadedConfig, type OAuthConfig } from './config.js';

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
  openBrowser?: boolean;
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

export async function loginWithOAuth(options: OAuthLoginOptions = {}, opener: BrowserOpener = openUrl): Promise<OAuthLoginResult> {
  const config = loadConfig({ configPath: options.configPath, env: options.env, cli: { host: options.host, authHost: options.authHost, clientId: options.clientId } });
  const clientId = options.clientId ?? config.clientId;
  if (!clientId) throw new Error('Missing OAuth client id. Set JINSHUJU_OAUTH_CLIENT_ID or config client_id.');

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

  if (options.openBrowser !== false) await opener(authorizeUrl);
  const code = await callback.code;
  const token = await exchangeAuthorizationCode(config.authHost, clientId, callback.redirectUri, code, verifier);
  const auth = toOAuthConfig(config, clientId, token);
  saveOAuthConfig(config.configPath, auth);
  return { authorizeUrl, callbackUrl: callback.redirectUri, token: auth };
}

export async function refreshOAuthToken(config: LoadedConfig): Promise<OAuthConfig> {
  if (!config.auth?.refresh_token) throw new Error('No OAuth refresh token. Run `jinshuju auth login` again.');
  const token = await tokenRequest(config.auth.auth_host, {
    grant_type: 'refresh_token',
    client_id: config.auth.client_id,
    refresh_token: config.auth.refresh_token
  });
  const auth = toOAuthConfig(config, config.auth.client_id, token, config.auth);
  saveOAuthConfig(config.configPath, auth);
  return auth;
}

export async function revokeOAuthToken(config: LoadedConfig): Promise<void> {
  if (!config.auth?.access_token) return;
  const url = new URL('/oauth/revoke', config.auth.auth_host);
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: config.auth.client_id, token: config.auth.access_token })
  }).catch(() => undefined);
  clearOAuthConfig(config.configPath);
}

export function shouldRefresh(auth: OAuthConfig, skewMs = 60_000): boolean {
  if (!auth.expires_at) return false;
  return Date.parse(auth.expires_at) - skewMs <= Date.now();
}

async function exchangeAuthorizationCode(authHost: string, clientId: string, redirectUri: string, code: string, codeVerifier: string): Promise<TokenResponse> {
  return tokenRequest(authHost, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });
}

async function tokenRequest(authHost: string, params: Record<string, string>): Promise<TokenResponse> {
  const url = new URL('/oauth/token', authHost);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params)
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(body?.error_description ?? body?.error ?? response.statusText);
  }
  if (!body?.access_token) throw new Error('OAuth token response is missing access_token');
  return body as TokenResponse;
}

function toOAuthConfig(config: LoadedConfig, clientId: string, token: TokenResponse, previous?: OAuthConfig): OAuthConfig {
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

function listenForOAuthCallback(expectedState: string, port = 0, timeoutMs = 120_000): Promise<{ redirectUri: string; code: Promise<string> }> {
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
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Jinshuju CLI login complete. You can close this tab.');
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

async function openUrl(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  await new Promise<void>((resolve) => execFile(command, args, (error) => (error ? resolve() : resolve())));
}
