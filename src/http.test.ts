import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { JinshujuHttpClient } from './http.js';
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
