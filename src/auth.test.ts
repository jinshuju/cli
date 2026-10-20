import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAuthorizationUrl,
  createPkcePair,
  DEVICE_CODE_GRANT_TYPE,
  loginWithDevice,
  loginWithOAuth,
  logout,
  refreshOAuthToken,
  resumeDeviceLogin,
  startDeviceLogin
} from './auth.js';
import { loadConfig, saveOAuthConfig } from './config.js';
import { runCli } from './cli.js';
import { AuthError, PendingError, UsageError } from './errors.js';

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

/**
 * An authorization server that hands out one device code and answers each
 * poll with the next of `answers` — an OAuth error name, or 'token'.
 */
async function deviceServer(answers: string[], delayMs = 0) {
  const polls: URLSearchParams[] = [];
  const server = await listenOnce((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/oauth/device_authorization') {
        res.end(
          JSON.stringify({
            device_code: 'device-1',
            user_code: 'BCDF-GHJK',
            verification_uri: 'https://account.example.com/oauth/device',
            verification_uri_complete: 'https://account.example.com/oauth/device?user_code=BCDF-GHJK',
            expires_in: 900,
            interval: 0
          })
        );
        return;
      }
      polls.push(new URLSearchParams(body));
      const answer = answers.shift() ?? 'authorization_pending';
      setTimeout(() => {
        if (res.destroyed) return;
        if (answer === 'token') {
          res.end(JSON.stringify({ access_token: 'device-access', refresh_token: 'device-refresh', expires_in: 7200 }));
        } else {
          res.writeHead(400).end(JSON.stringify({ error: answer }));
        }
      }, delayMs);
    });
  });
  const dir = mkdtempSync(join(tmpdir(), 'jsj-device-'));
  const configPath = join(dir, 'config.json');
  return {
    ...server,
    polls,
    configPath,
    target: { configPath, env: {}, authHost: server.url, clientId: 'cli' },
    cleanup: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('a device login polls until approved, slowing down when asked, and stores the session', async () => {
  const auth = await deviceServer(['authorization_pending', 'slow_down', 'token']);
  const waits: number[] = [];
  let shown = '';
  const token = await loginWithDevice({ ...auth.target, sleep: async (ms) => void waits.push(ms) }, (pending) => {
    shown = pending.user_code;
  });
  const saved = JSON.parse(readFileSync(auth.configPath, 'utf8'));
  auth.cleanup();

  assert.equal(shown, 'BCDF-GHJK');
  assert.deepEqual(waits, [0, 5000]);
  assert.equal(auth.polls[0]?.get('grant_type'), DEVICE_CODE_GRANT_TYPE);
  assert.equal(auth.polls[0]?.get('device_code'), 'device-1');
  assert.equal(auth.polls[0]?.get('client_id'), 'cli');
  assert.equal(token.access_token, 'device-access');
  assert.equal(saved.auth.refresh_token, 'device-refresh');
  assert.equal(saved.pending_device, undefined);
});

test('a device login the person refused ends with an auth error', async () => {
  const auth = await deviceServer(['access_denied']);
  const error = await loginWithDevice({ ...auth.target, sleep: async () => {} }, () => {}).catch((e: Error) => e);
  auth.cleanup();

  assert.ok(error instanceof AuthError);
  assert.match(error.message, /refused/);
});

test('a device login started without waiting is finished by resume, which says when it is still pending', async () => {
  const auth = await deviceServer(['authorization_pending', 'token']);
  const pending = await startDeviceLogin(auth.target);
  const stored = JSON.parse(readFileSync(auth.configPath, 'utf8'));

  const early = await resumeDeviceLogin({ ...auth.target, waitMs: 0 }).catch((e: Error) => e);
  const token = await resumeDeviceLogin({ ...auth.target, waitMs: 0 });
  const saved = JSON.parse(readFileSync(auth.configPath, 'utf8'));
  auth.cleanup();

  assert.equal(pending.user_code, 'BCDF-GHJK');
  assert.equal(stored.pending_device.device_code, 'device-1');
  assert.equal(stored.auth, undefined);
  assert.ok(early instanceof PendingError);
  assert.match(early.message, /BCDF-GHJK/);
  assert.equal(token.access_token, 'device-access');
  assert.equal(saved.pending_device, undefined);
});

test('refreshing the session in use leaves a device login started with --no-wait waiting', async () => {
  const auth = await deviceServer(['token', 'token']);
  saveOAuthConfig(auth.configPath, {
    type: 'oauth',
    auth_host: auth.url,
    client_id: 'cli',
    access_token: 'old',
    refresh_token: 'old-refresh'
  });
  await startDeviceLogin(auth.target);

  await refreshOAuthToken(loadConfig({ configPath: auth.configPath, env: {} }));
  const afterRefresh = JSON.parse(readFileSync(auth.configPath, 'utf8'));
  const token = await resumeDeviceLogin({ ...auth.target, waitMs: 0 });
  auth.cleanup();

  assert.equal(afterRefresh.pending_device.device_code, 'device-1');
  assert.equal(token.access_token, 'device-access');
});

test('logging out drops a device login still waiting, so approving it later logs nothing in', async () => {
  const auth = await deviceServer(['token']);
  await startDeviceLogin(auth.target);

  await logout(loadConfig({ configPath: auth.configPath, env: {} }));
  const error = await resumeDeviceLogin({ ...auth.target, waitMs: 0 }).catch((e: Error) => e);
  const saved = JSON.parse(readFileSync(auth.configPath, 'utf8'));
  auth.cleanup();

  assert.equal(saved.pending_device, undefined);
  assert.ok(error instanceof UsageError);
  assert.equal(auth.polls.length, 0);
});

test('resume stops at its timeout even while a poll is still waiting for an answer', async () => {
  const auth = await deviceServer(['authorization_pending'], 2_000);
  await startDeviceLogin(auth.target);

  const started = Date.now();
  const error = await resumeDeviceLogin({ ...auth.target, waitMs: 300 }).catch((e: Error) => e);
  const took = Date.now() - started;
  auth.cleanup();

  assert.ok(error instanceof PendingError);
  assert.ok(took < 1_000, `took ${took}ms`);
});

test('resume with no device login waiting says how to start one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-device-none-'));
  const error = await resumeDeviceLogin({ configPath: join(dir, 'config.json'), env: {} }).catch((e: Error) => e);
  rmSync(dir, { recursive: true, force: true });

  assert.ok(error instanceof UsageError);
  assert.match(error.message, /--no-wait/);
});

test('auth login --no-wait prints the link and code for an agent, and --resume exits 9 while pending', async () => {
  const auth = await deviceServer(['authorization_pending']);
  const env = { JINSHUJU_AUTH_HOST: auth.url, JINSHUJU_OAUTH_CLIENT_ID: 'cli' };

  const started = await runCli(['auth', 'login', '--no-wait', '--output', 'json', '--config', auth.configPath], {
    env
  });
  const resumed = await runCli(
    ['auth', 'login', '--resume', '--timeout', '0', '--output', 'json', '--config', auth.configPath],
    { env }
  );
  const both = await runCli(['auth', 'login', '--no-wait', '--resume', '--config', auth.configPath], { env });
  auth.cleanup();

  assert.equal(started.exitCode, 0);
  assert.deepEqual(
    {
      ...JSON.parse(started.stdout),
      expires_at: undefined
    },
    {
      authenticated: false,
      pending: true,
      user_code: 'BCDF-GHJK',
      verification_uri: 'https://account.example.com/oauth/device',
      verification_uri_complete: 'https://account.example.com/oauth/device?user_code=BCDF-GHJK',
      expires_at: undefined,
      resume: 'jinshuju auth login --resume'
    }
  );
  assert.equal(resumed.exitCode, 9);
  assert.equal(JSON.parse(resumed.stderr).error.kind, 'pending');
  assert.equal(both.exitCode, 2);
});
