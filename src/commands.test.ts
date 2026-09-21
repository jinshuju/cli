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

test('auth status reports configured credentials and supports API key mode', async () => {
  const result = await runCli(['auth', 'status', '--output', 'json'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' }
  });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.authenticated, true);
  assert.equal(body.mode, 'api_key_secret');
  assert.equal(body.sources.apiKey, 'env');
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

test('text output for API commands prints a human-readable response instead of JSON or placeholders', async () => {
  const client = {
    async request<T>(): Promise<T> {
      return {
        total: 2,
        count: 2,
        data: [
          { token: 'BaLZpn', name: '报名表', status: 'active', fields: [{ type: 'TextField' }] },
          { token: 'Cx9Kq2', name: '反馈表', status: 'archived', fields: [] }
        ]
      } as T;
    }
  };

  const result = await runCli(['entry', 'list', '--form', 'BaLZpn', '--view', 'Mixqc1', '--output', 'text'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /total: 2/);
  assert.match(result.stdout, /token\s+name\s+status/);
  assert.match(result.stdout, /BaLZpn\s+报名表\s+active/);
  assert.doesNotMatch(result.stdout, /"total": 2/);
  assert.doesNotMatch(result.stdout, /Entries fetched/);
});

test('API command errors are returned as CLI errors instead of uncaught promise rejections', async () => {
  const result = await runCli(['form', 'list'], { env: {} });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Missing authentication/);
});

test('entry list forwards the cursor back verbatim', async () => {
  const mock = createMockClient();

  const result = await runCli(['entry', 'list', '--form', 'BaLZpn', '--next', '51'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: mock.client
  });

  assert.equal(result.exitCode, 0);
  assert.equal(mock.requests[0].method, 'GET');
  assert.equal(mock.requests[0].path, '/api/v1/forms/BaLZpn/entries?next=51');
});

test('form list and a view listing also forward the cursor', async () => {
  const formList = createMockClient();
  const viewEntries = createMockClient();

  await runCli(['form', 'list', '--next', '60cc514761936ced06123456'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: formList.client
  });
  await runCli(['entry', 'list', '--form', 'BaLZpn', '--view', 'Mixqc1', '--next', '51'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: viewEntries.client
  });

  assert.equal(formList.requests[0].path, '/api/v1/forms?next=60cc514761936ced06123456');
  assert.equal(viewEntries.requests[0].path, '/api/v1/forms/BaLZpn/views/Mixqc1/entries?next=51');
});

test('page and per-page options are not exposed as CLI options', async () => {
  const result = await runCli(['entry', 'list', '--form', 'BaLZpn', '--output', 'text', '--per-page', '100'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: createMockClient().client
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /does not take --per-page/);
});

test('view get names its container flags and its token argument', async () => {
  const result = await runCli(['view', 'get', '--help']);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage: jinshuju view get <view>/);
  assert.match(result.stdout, /--form/);
  assert.match(result.stdout, /--table/);
});

test('an access token is sent as a bearer, and outranks the other credentials', async () => {
  const seen: (string | undefined)[] = [];
  const fetchMock = async (_url: unknown, init: { headers: Record<string, string> }) => {
    seen.push(init.headers.Authorization);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    await runCli(['form', 'list'], { env: { JINSHUJU_ACCESS_TOKEN: 'tok_abc' } });
    // A stored API key must not win over a token the caller set for this run.
    await runCli(['form', 'list'], {
      env: { JINSHUJU_ACCESS_TOKEN: 'tok_abc', JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' }
    });
    await runCli(['form', 'list'], { env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' } });
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(seen, ['Bearer tok_abc', 'Bearer tok_abc', `Basic ${Buffer.from('key:secret').toString('base64')}`]);
});

test('auth status names the access token and where it came from', async () => {
  const result = await runCli(['auth', 'status', '--output', 'json'], { env: { JINSHUJU_ACCESS_TOKEN: 'tok_abc' } });

  const body = JSON.parse(result.stdout);
  assert.equal(body.authenticated, true);
  assert.equal(body.mode, 'access_token');
  assert.equal(body.source, 'env');
});

test('an access token is masked like the other secrets', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = join(mkdtempSync(join(tmpdir(), 'jsj-')), 'config.json');
  writeFileSync(path, JSON.stringify({ access_token: 'tok_abcdefghijkl' }));

  const masked = await runCli(['config', 'get', '--config', path, '--output', 'json'], { env: {} });
  assert.equal(JSON.parse(masked.stdout).access_token, 'tok_…ijkl');

  const shown = await runCli(['config', 'get', '--config', path, '--show-secret', '--output', 'json'], { env: {} });
  assert.equal(JSON.parse(shown.stdout).access_token, 'tok_abcdefghijkl');
});

test('config set accepts access_token', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = join(mkdtempSync(join(tmpdir(), 'jsj-')), 'config.json');

  const result = await runCli(['config', 'set', 'access_token', 'tok_xyz', '--config', path], { env: {} });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).access_token, 'tok_xyz');
});
