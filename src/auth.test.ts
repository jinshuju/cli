import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAuthorizationUrl, createPkcePair, loginWithOAuth, refreshOAuthToken } from './auth.js';
import { loadConfig, saveOAuthConfig } from './config.js';
import { AuthError } from './errors.js';

function listenOnce(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listen failed');
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => server.close() });
    });
  });
}

test('createPkcePair returns an S256 verifier/challenge pair shape', () => {
  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(pair.verifier, pair.challenge);
});

test('buildAuthorizationUrl includes OAuth PKCE and loopback params', () => {
  const url = new URL(
    buildAuthorizationUrl({
      authHost: 'https://account.example.com',
      clientId: 'cli-client',
      redirectUri: 'http://127.0.0.1:12345/oauth/callback',
      scope: 'public forms',
      state: 'state-1',
      codeChallenge: 'challenge-1'
    })
  );

  assert.equal(url.origin, 'https://account.example.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cli-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:12345/oauth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('loginWithOAuth validates callback state, exchanges token, and stores OAuth session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-oauth-'));
  const configPath = join(dir, 'config.json');
  let authorizeUrl = '';
  let exchangedBody = '';
  const authServer = await listenOnce((req, res) => {
    if (req.url === '/oauth/token' && req.method === 'POST') {
      req.on('data', (chunk: Buffer) => {
        exchangedBody += chunk.toString();
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
            scope: 'public forms'
          })
        );
      });
      return;
    }
    res.writeHead(404).end();
  });

  const loginPromise = loginWithOAuth(
    {
      configPath,
      env: {},
      authHost: authServer.url,
      clientId: 'cli-client',
      openBrowser: true,
      timeoutMs: 5_000
    },
    async (url) => {
      authorizeUrl = url;
      const parsed = new URL(url);
      const redirect = new URL(parsed.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('state', parsed.searchParams.get('state') ?? '');
      redirect.searchParams.set('code', 'auth-code');
      await fetch(redirect);
    }
  );

  const result = await loginPromise;
  assert.match(authorizeUrl, /code_challenge_method=S256/);
  assert.equal(result.token.access_token, 'new-access');
  assert.match(exchangedBody, /grant_type=authorization_code/);
  assert.match(exchangedBody, /code_verifier=/);
  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(saved.auth.access_token, 'new-access');
  assert.equal(saved.auth.refresh_token, 'new-refresh');
  authServer.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a token endpoint that answers HTML is reported as its status, not as a parse error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-oauth-html-'));
  const configPath = join(dir, 'config.json');
  const authServer = await listenOnce((_req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>502 Bad Gateway</h1></body></html>');
  });
  saveOAuthConfig(configPath, {
    type: 'oauth',
    auth_host: authServer.url,
    client_id: 'cli',
    access_token: 'old',
    refresh_token: 'refresh'
  });

  const error = await refreshOAuthToken(loadConfig({ configPath, env: {} })).catch((e: Error) => e);
  authServer.close();
  rmSync(dir, { recursive: true, force: true });

  assert.ok(error instanceof AuthError);
  assert.match(error.message, /^502 /);
  assert.match(error.message, /not JSON/);
  assert.doesNotMatch(error.message, /Unexpected token/);
});

/** A login whose browser step is scripted: the opener is handed the authorize URL and answers the callback itself. */
function loginAnswering(answer: (redirect: URL, state: string) => Promise<void>, timeoutMs = 5_000): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-oauth-cb-'));
  return loginWithOAuth(
    { configPath: join(dir, 'config.json'), env: {}, authHost: 'http://127.0.0.1:9', clientId: 'cli', timeoutMs },
    async (url) => {
      const parsed = new URL(url);
      await answer(new URL(parsed.searchParams.get('redirect_uri') ?? ''), parsed.searchParams.get('state') ?? '');
    }
  ).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('a login nobody completes times out, rather than holding the port forever', async () => {
  const error = await loginAnswering(async () => {}, 100).catch((e: Error) => e);
  assert.ok(error instanceof Error);
  assert.match(error.message, /timed out/);
});

test('a callback with the wrong state is refused, and the login fails with it', async () => {
  let answered = 0;
  const error = await loginAnswering(async (redirect) => {
    redirect.searchParams.set('state', 'forged');
    redirect.searchParams.set('code', 'x');
    answered = (await fetch(redirect)).status;
  }).catch((e: Error) => e);

  assert.equal(answered, 400);
  assert.ok(error instanceof Error);
  assert.match(error.message, /Invalid OAuth state/);
});

test('a callback carrying an error from the authorization server ends the login with that error', async () => {
  const error = await loginAnswering(async (redirect, state) => {
    redirect.searchParams.set('state', state);
    redirect.searchParams.set('error', 'access_denied');
    await fetch(redirect);
  }).catch((e: Error) => e);

  assert.ok(error instanceof Error);
  assert.equal(error.message, 'access_denied');
});

test('a callback with the right state but no code is refused', async () => {
  const error = await loginAnswering(async (redirect, state) => {
    redirect.searchParams.set('state', state);
    await fetch(redirect);
  }).catch((e: Error) => e);

  assert.ok(error instanceof Error);
  assert.match(error.message, /Missing OAuth code/);
});

test('a request for any other path on the callback server is a 404 and the login keeps waiting', async () => {
  const error = await loginAnswering(async (redirect) => {
    const other = new URL('/favicon.ico', redirect);
    assert.equal((await fetch(other)).status, 404);
  }, 150).catch((e: Error) => e);

  assert.ok(error instanceof Error);
  assert.match(error.message, /timed out/);
});
