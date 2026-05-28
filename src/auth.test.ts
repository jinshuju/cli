import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAuthorizationUrl, createPkcePair, loginWithOAuth } from './auth.js';

function listenOnce(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => void }> {
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
  const url = new URL(buildAuthorizationUrl({
    authHost: 'https://account.example.com',
    clientId: 'cli-client',
    redirectUri: 'http://127.0.0.1:12345/oauth/callback',
    scope: 'public forms',
    state: 'state-1',
    codeChallenge: 'challenge-1'
  }));

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
      req.on('data', (chunk: Buffer) => { exchangedBody += chunk.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'public forms' }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  const loginPromise = loginWithOAuth({
    configPath,
    env: {},
    authHost: authServer.url,
    clientId: 'cli-client',
    openBrowser: true,
    timeoutMs: 5_000
  }, async (url) => {
    authorizeUrl = url;
    const parsed = new URL(url);
    const redirect = new URL(parsed.searchParams.get('redirect_uri') ?? '');
    redirect.searchParams.set('state', parsed.searchParams.get('state') ?? '');
    redirect.searchParams.set('code', 'auth-code');
    await fetch(redirect);
  });

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
