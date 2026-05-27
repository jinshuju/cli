import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from './cli.js';
import type { HttpRequest } from './http.js';

function createMockClient() {
  const requests: HttpRequest[] = [];
  return {
    requests,
    client: {
      async request<T>(request: HttpRequest): Promise<T> {
        requests.push(request);
        return { ok: true, request } as T;
      }
    }
  };
}

test('auth status reports configured credentials without login/logout session', async () => {
  const result = await runCli(['auth', 'status', '--output', 'json'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' }
  });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.authenticated, true);
  assert.equal(body.mode, 'api_key_secret');
  assert.match(body.notes, /no session/i);
});

test('form create posts API v1 payload without injecting api_code', async () => {
  const mock = createMockClient();
  const payload = {
    name: '活动报名表',
    fields: [
      { type: 'TextField', label: '姓名', required: true },
      { type: 'MobileField', label: '手机号', required: true }
    ]
  };

  const result = await runCli(['form', 'create', '--json', JSON.stringify(payload), '--output', 'json'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: mock.client
  });

  assert.equal(result.exitCode, 0);
  assert.equal(mock.requests[0].method, 'POST');
  assert.equal(mock.requests[0].path, '/api/v1/forms');
  assert.deepEqual(mock.requests[0].body, payload);
  assert.equal(JSON.stringify(mock.requests[0].body).includes('api_code'), false);
});

test('form create rejects non API v1 field type', async () => {
  const payload = { name: '活动报名表', fields: [{ type: 'text', label: '姓名' }] };
  const result = await runCli(['form', 'create', '--json', JSON.stringify(payload)], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: createMockClient().client
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /API v1 field type/);
});

test('text output for API commands prints the response body instead of a placeholder', async () => {
  const client = {
    async request<T>(): Promise<T> {
      return { total: 0, count: 0, data: [], next: null } as T;
    }
  };

  const result = await runCli(['form', 'view', 'entry', 'list', 'BaLZpn', 'Mixqc1', '--output', 'text'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"total": 0/);
  assert.match(result.stdout, /"data": \[\]/);
  assert.doesNotMatch(result.stdout, /Entries fetched/);
});

test('API command errors are returned as CLI errors instead of uncaught promise rejections', async () => {
  const result = await runCli(['form', 'list'], { env: {} });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Missing JINSHUJU_API_KEY or JINSHUJU_API_SECRET/);
});

test('view help documents six character alphanumeric token', async () => {
  const result = await runCli(['form', 'view', 'get', '--help']);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Six-character alphanumeric/);
  assert.match(result.stdout, /aB3dE9/);
});
