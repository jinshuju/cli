import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { HttpError, JinshujuHttpClient, TransportError } from './http.js';
import { loadConfig } from './config.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NO_CONFIG = join(mkdtempSync(join(tmpdir(), 'jsj-http-')), 'config.json');

type Answer = { status: number; body: string; type?: string };

/** A server that answers each path with the response that path is named for. */
function serve(answers: Record<string, Answer>): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const answer = answers[(req.url ?? '').split('?')[0] as string];
      if (!answer) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error_description":"no such stub"}');
        return;
      }
      res.writeHead(answer.status, { 'Content-Type': answer.type ?? 'application/json' });
      res.end(answer.body);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listen failed');
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function clientFor(host: string) {
  return new JinshujuHttpClient(
    loadConfig({
      configPath: NO_CONFIG,
      env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret', JINSHUJU_HOST: host }
    })
  );
}

async function failure(host: string, path: string): Promise<Error & { status?: number; body?: unknown }> {
  try {
    await clientFor(host).request({ method: 'GET', path });
  } catch (error) {
    return error as Error & { status?: number; body?: unknown };
  }
  throw new Error(`${path} was expected to fail`);
}

const HTML_500 =
  '<!DOCTYPE html><html><head><title>Action Controller: Exception caught</title></head>' +
  "<body><h1>NoMethodError</h1><p>undefined method `abort?' for nil</p></body></html>";

test('a server that states a reason has it repeated, and nothing added to it', async () => {
  const server = await serve({
    '/api/v1/forms/ZZZZZZ': { status: 404, body: '{"error_description":"form cannot be found"}' }
  });
  const error = await failure(server.url, '/api/v1/forms/ZZZZZZ');
  await server.close();

  assert.equal(error.message, 'form cannot be found');
  assert.equal(error.status, 404);
});

test('a per-row rejection names the rows, rather than collapsing to the HTTP status text', async () => {
  const server = await serve({
    '/api/v1/forms/Kp7mQ2/entries/batch': {
      status: 422,
      body: JSON.stringify({
        created_count: 0,
        errors: [
          { index: 0, reason: 'Field 2请填写手机号' },
          { index: 1, reason: 'Field 5请填写组别' }
        ]
      })
    }
  });
  const error = await failure(server.url, '/api/v1/forms/Kp7mQ2/entries/batch');
  await server.close();

  assert.match(error.message, /2 rows rejected/);
  assert.match(error.message, /row 0: Field 2请填写手机号/);
  assert.match(error.message, /row 1: Field 5请填写组别/);
  assert.doesNotMatch(error.message, /Unprocessable/);
  assert.equal(error.status, 422);
});

test('an HTML error page is reported as the status it is, not as broken JSON', async () => {
  const server = await serve({
    '/api/v1/forms/Kp7mQ2/field_rules': { status: 500, body: HTML_500, type: 'text/html' }
  });
  const error = await failure(server.url, '/api/v1/forms/Kp7mQ2/field_rules');
  await server.close();

  assert.match(error.message, /^500 /);
  assert.match(error.message, /not JSON/);
  assert.match(error.message, /NoMethodError/);
  // The failure that made this worth fixing: the status was lost inside a parse error.
  assert.doesNotMatch(error.message, /Unexpected token/);
  assert.equal(error.status, 500);
  assert.equal(typeof error.body, 'string');
});

test('an error body in a shape nobody anticipated is shown rather than dropped', async () => {
  const server = await serve({
    '/api/v1/utils/x': { status: 400, body: '{"detail":{"why":"quota exhausted"}}' }
  });
  const error = await failure(server.url, '/api/v1/utils/x');
  await server.close();

  assert.match(error.message, /400/);
  assert.match(error.message, /quota exhausted/);
});

test('a success that is not JSON says so, instead of throwing a parse error', async () => {
  const server = await serve({
    '/api/v1/forms': { status: 200, body: '<html>a login page</html>', type: 'text/html' }
  });
  let message = '';
  try {
    await clientFor(server.url).request({ method: 'GET', path: '/api/v1/forms' });
  } catch (error) {
    message = (error as Error).message;
  }
  await server.close();

  assert.match(message, /200/);
  assert.match(message, /not JSON/);
  assert.doesNotMatch(message, /Unexpected token/);
});

test('an empty body on a successful response is not an error', async () => {
  const server = await serve({ '/api/v1/forms/Kp7mQ2/entries/1': { status: 204, body: '' } });
  const answer = await clientFor(server.url).request({ method: 'GET', path: '/api/v1/forms/Kp7mQ2/entries/1' });
  await server.close();

  assert.equal(answer, undefined);
});

// --- retries and timeouts ----------------------------------------------------

type Scripted = { status: number; body?: string; headers?: Record<string, string> };

/**
 * A server that answers one path with a scripted sequence, one response per
 * request, repeating the last forever. It records what it was asked so a test
 * can say how many attempts were made and what headers they carried.
 */
function script(answers: Scripted[]): Promise<{
  url: string;
  hits: { method: string; headers: Record<string, string | string[] | undefined> }[];
  close: () => Promise<void>;
}> {
  const hits: { method: string; headers: Record<string, string | string[] | undefined> }[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      hits.push({ method: req.method ?? '', headers: req.headers });
      const answer = answers[Math.min(hits.length - 1, answers.length - 1)] as Scripted;
      res.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers });
      res.end(answer.body ?? '{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listen failed');
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        hits,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

/** A client whose waits are recorded instead of slept. */
function quickClient(host: string, options: { retries?: number; timeoutMs?: number } = {}) {
  const waits: number[] = [];
  const client = new JinshujuHttpClient(
    loadConfig({
      configPath: NO_CONFIG,
      env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret', JINSHUJU_HOST: host }
    }),
    {
      ...options,
      sleep: async (ms) => {
        waits.push(ms);
      }
    }
  );
  return { client, waits };
}

test('a 429 is tried again after backing off, and the answer that follows is the answer', async () => {
  const server = await script([{ status: 429 }, { status: 429 }, { status: 200, body: '{"ok":true}' }]);
  const { client, waits } = quickClient(server.url);
  const answer = await client.request<{ ok: boolean }>({ method: 'GET', path: '/api/v1/forms' });
  await server.close();

  assert.deepEqual(answer, { ok: true });
  assert.equal(server.hits.length, 3);
  assert.equal(waits.length, 2);
  // Doubling: the second wait is roughly twice the first, jitter aside.
  assert.ok((waits[1] as number) > (waits[0] as number));
});

test('Retry-After is honoured over the backoff schedule', async () => {
  const server = await script([{ status: 503, headers: { 'Retry-After': '2' } }, { status: 200 }]);
  const { client, waits } = quickClient(server.url);
  await client.request({ method: 'GET', path: '/api/v1/forms' });
  await server.close();

  assert.deepEqual(waits, [2000]);
});

test('a write is tried again on 429 and 503 only; a 500 may already have landed', async () => {
  const later = await script([{ status: 503 }, { status: 201, body: '{"token":"Kp7mQ2"}' }]);
  const { client: patient } = quickClient(later.url);
  const created = await patient.request({ method: 'POST', path: '/api/v1/forms', body: { name: 'x' } });
  await later.close();
  assert.deepEqual(created, { token: 'Kp7mQ2' });
  assert.equal(later.hits.length, 2);

  const broken = await script([{ status: 500, body: '{"message":"boom"}' }, { status: 201 }]);
  const { client: once, waits } = quickClient(broken.url);
  await assert.rejects(once.request({ method: 'POST', path: '/api/v1/forms', body: { name: 'x' } }), /boom/);
  await broken.close();
  assert.equal(broken.hits.length, 1);
  assert.deepEqual(waits, []);
});

test('a read is tried again on a gateway failure, up to the retry budget, then reported', async () => {
  const server = await script([{ status: 502, body: '<html>bad gateway</html>' }]);
  const { client, waits } = quickClient(server.url, { retries: 2 });
  const error = await client.request({ method: 'GET', path: '/api/v1/forms' }).catch((e: Error) => e);
  await server.close();

  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 502);
  assert.equal(server.hits.length, 3);
  assert.equal(waits.length, 2);
});

test('a request that gets no answer in time fails as a timeout, naming the deadline', async () => {
  const server = createServer(() => {
    // Never answers.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  const { client } = quickClient(`http://127.0.0.1:${address.port}`, { retries: 0, timeoutMs: 50 });

  const error = await client.request({ method: 'GET', path: '/api/v1/forms' }).catch((e: Error) => e);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();

  assert.ok(error instanceof TransportError);
  assert.equal(error.timedOut, true);
  assert.match(error.message, /timed out after 50ms/);
});

test('a server nobody is listening on is a transport error, not a stack trace', async () => {
  const { client } = quickClient('http://127.0.0.1:9', { retries: 0 });
  const error = await client.request({ method: 'GET', path: '/api/v1/forms' }).catch((e: Error) => e);

  assert.ok(error instanceof TransportError);
  assert.equal(error.timedOut, false);
  assert.match(error.message, /could not reach the server/);
});

test('every request says which client it is', async () => {
  const server = await script([{ status: 200 }]);
  const { client } = quickClient(server.url);
  await client.request({ method: 'GET', path: '/api/v1/forms' });
  await server.close();

  assert.match(String(server.hits[0]?.headers['user-agent']), /^jinshuju-cli\/\S+ node\//);
});

test('JINSHUJU_TIMEOUT_MS sets the deadline, and refuses what is not a number', () => {
  assert.equal(loadConfig({ configPath: NO_CONFIG, env: { JINSHUJU_TIMEOUT_MS: '5000' } }).timeoutMs, 5000);
  assert.equal(loadConfig({ configPath: NO_CONFIG, env: {} }).timeoutMs, undefined);
  assert.throws(() => loadConfig({ configPath: NO_CONFIG, env: { JINSHUJU_TIMEOUT_MS: 'soon' } }), /whole number/);
});
