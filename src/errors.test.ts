import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from './cli.js';
import { AuthError, RefusedError, UsageError, classify } from './errors.js';
import { HttpError, TransportError } from './http.js';

const NO_CONFIG = join(mkdtempSync(join(tmpdir(), 'jsj-errors-')), 'config.json');
const ENV = { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' };

test('every kind of failure has its own exit code', () => {
  assert.equal(classify(new UsageError('x')).exitCode, 2);
  assert.equal(classify(new AuthError('x')).exitCode, 3);
  assert.equal(classify(new HttpError('x', 401, undefined)).exitCode, 3);
  assert.equal(classify(new HttpError('x', 403, undefined)).exitCode, 3);
  assert.equal(classify(new HttpError('x', 404, undefined)).exitCode, 4);
  assert.equal(classify(new HttpError('x', 422, undefined)).exitCode, 5);
  assert.equal(classify(new RefusedError('x')).exitCode, 5);
  assert.equal(classify(new HttpError('x', 500, undefined)).exitCode, 6);
  assert.equal(classify(new TransportError('x', true)).exitCode, 7);
  assert.equal(classify(new Error('x')).exitCode, 1);
});

test('an error that wraps another is sorted by what it wraps, but keeps its own words', () => {
  const wrapped = new Error('form Kp7mQ2 was created, but its exam_setting was refused', {
    cause: new HttpError('not an exam', 422, undefined)
  });
  const sorted = classify(wrapped);
  assert.equal(sorted.kind, 'refused');
  assert.equal(sorted.status, 422);
  assert.match(sorted.message, /was created/);
});

test('--output json answers a failure as JSON on stderr, with the status and body the server sent', async () => {
  const client = {
    async request<T>(): Promise<T> {
      throw new HttpError('form cannot be found', 404, { error_description: 'form cannot be found' });
    }
  };
  const result = await runCli(['form', 'get', 'ZZZZZZ', '--output', 'json', '--config', NO_CONFIG], {
    env: ENV,
    client
  });

  assert.equal(result.exitCode, 4);
  assert.equal(result.stdout, '');
  const envelope = JSON.parse(result.stderr) as { error: Record<string, unknown> };
  assert.equal(envelope.error.kind, 'not_found');
  assert.equal(envelope.error.message, 'form cannot be found');
  assert.equal(envelope.error.status, 404);
  assert.deepEqual(envelope.error.body, { error_description: 'form cannot be found' });
});

test('a usage error is JSON too when JSON was asked for, and an unknown command is a usage error', async () => {
  const usage = await runCli(['entry', 'list', '--output', 'json', '--config', NO_CONFIG], { env: ENV });
  assert.equal(usage.exitCode, 2);
  assert.equal((JSON.parse(usage.stderr) as { error: { kind: string } }).error.kind, 'usage');

  const unknown = await runCli(['form', 'frobnicate', '--config', NO_CONFIG], { env: ENV });
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.stderr, /Unknown command: jinshuju form frobnicate/);
  assert.match(unknown.stderr, /Did you mean/);

  const unknownJson = await runCli(['form', 'frobnicate', '--output', 'json', '--config', NO_CONFIG], { env: ENV });
  assert.equal(unknownJson.exitCode, 2);
  assert.match((JSON.parse(unknownJson.stderr) as { error: { message: string } }).error.message, /Unknown command/);
});

test('in text mode a failure still reads as it always did', async () => {
  const result = await runCli(['entry', 'list', '--config', NO_CONFIG], { env: ENV });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /^Error: one of --form <token> or --table <token> is required\n$/);
});
