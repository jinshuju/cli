import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli, type CliRuntime } from './cli.js';
import type { HttpRequest } from './http.js';

/**
 * A path with no file behind it, so a test never reads the config of whoever is
 * running it. Without this the suite passes or fails by what is in the
 * developer's ~/.jinshuju/config.json, and CI — which has none — would never
 * show it.
 */
const NO_CONFIG = join(mkdtempSync(join(tmpdir(), 'jsj-test-')), 'config.json');

function cli(args: string[], runtime: CliRuntime = {}) {
  return runCli([...args, '--config', NO_CONFIG], runtime);
}

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
  const result = await cli(['auth', 'status', '--output', 'json'], {
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

  const result = await cli(['form', 'create', '--json', JSON.stringify(payload), '--output', 'json'], {
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
  const result = await cli(['form', 'create', '--json', JSON.stringify(payload)], {
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

  const result = await cli(['entry', 'list', '--form', 'BaLZpn', '--view', 'Mixqc1', '--output', 'text'], {
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
  const result = await cli(['form', 'list'], { env: {} });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Missing authentication/);
});

test('entry list forwards the cursor back verbatim', async () => {
  const mock = createMockClient();

  const result = await cli(['entry', 'list', '--form', 'BaLZpn', '--next', '51'], {
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

  await cli(['form', 'list', '--next', '60cc514761936ced06123456'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: formList.client
  });
  await cli(['entry', 'list', '--form', 'BaLZpn', '--view', 'Mixqc1', '--next', '51'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: viewEntries.client
  });

  assert.equal(formList.requests[0].path, '/api/v1/forms?next=60cc514761936ced06123456');
  assert.equal(viewEntries.requests[0].path, '/api/v1/forms/BaLZpn/views/Mixqc1/entries?next=51');
});

test('--limit rides along on listings, including the two without a cursor', async () => {
  const entries = createMockClient();
  const folders = createMockClient();
  const members = createMockClient();
  const env = { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' };

  await cli(['entry', 'list', '--form', 'BaLZpn', '--limit', '5'], { env, client: entries.client });
  await cli(['folder', 'list', '--limit', '5'], { env, client: folders.client });
  await cli(['account', 'member', 'list', '--limit', '5'], { env, client: members.client });

  assert.equal(entries.requests[0].path, '/api/v1/forms/BaLZpn/entries?limit=5');
  assert.equal(folders.requests[0].path, '/api/v1/folders?limit=5');
  assert.equal(members.requests[0].path, '/api/v1/billing_account/users?limit=5');
});

test('page and per-page options are not exposed as CLI options', async () => {
  const result = await cli(['entry', 'list', '--form', 'BaLZpn', '--output', 'text', '--per-page', '100'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: createMockClient().client
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /does not take --per-page/);
});

test('view get names its container flags and its token argument', async () => {
  const result = await cli(['view', 'get', '--help']);

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
    await cli(['form', 'list'], { env: { JINSHUJU_ACCESS_TOKEN: 'tok_abc' } });
    // A stored API key must not win over a token the caller set for this run.
    await cli(['form', 'list'], {
      env: { JINSHUJU_ACCESS_TOKEN: 'tok_abc', JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' }
    });
    await cli(['form', 'list'], { env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' } });
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(seen, ['Bearer tok_abc', 'Bearer tok_abc', `Basic ${Buffer.from('key:secret').toString('base64')}`]);
});

test('auth status names the access token and where it came from', async () => {
  const result = await cli(['auth', 'status', '--output', 'json'], { env: { JINSHUJU_ACCESS_TOKEN: 'tok_abc' } });

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

test('entry count takes one container, or several through the batch endpoint', async () => {
  const one = createMockClient();
  const many = createMockClient();
  const env = { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' };

  await cli(['entry', 'count', '--table', 'Vn4xR8', '--keyword', '张三'], { env, client: one.client });
  await cli(['entry', 'count', '--form', 'Kp7mQ2', '--form', 'aB3dE9'], { env, client: many.client });

  assert.equal(one.requests[0].path, '/api/v1/tables/Vn4xR8/entries/count?keyword=%E5%BC%A0%E4%B8%89');
  assert.equal(many.requests[0].path, '/api/v1/entries/count?form_tokens=Kp7mQ2%2CaB3dE9');
});

test('entry count refuses more containers than the endpoint accepts', async () => {
  const tokens = Array.from({ length: 11 }, (_, index) => ['--form', `Kp7mQ${index}`]).flat();
  const result = await cli(['entry', 'count', ...tokens], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: createMockClient().client
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /at most 10 containers/);
});

test('entry aggregate turns --metric and --by into the JSON the API reads', async () => {
  const mock = createMockClient();

  const result = await cli(
    ['entry', 'aggregate', '--form', 'Kp7mQ2', '--metric', 'avg:field_3', '--metric', 'sum:field_5',
     '--by', 'field_7', '--by', 'created_at:month', '--limit', '5'],
    { env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' }, client: mock.client }
  );

  assert.equal(result.exitCode, 0);
  const query = new URL(mock.requests[0].path, 'https://x').searchParams;
  assert.equal(query.get('metrics'), '[{"func":"avg","field":"field_3"},{"func":"sum","field":"field_5"}]');
  assert.equal(query.get('dimensions'), '[{"field":"field_7"},{"field":"created_at","bucket":"month"}]');
  assert.equal(query.get('limit'), '5');
});

test('entry aggregate needs a metric, and names the buckets a dimension may take', async () => {
  const env = { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' };
  const noMetric = await cli(['entry', 'aggregate', '--form', 'Kp7mQ2'], { env, client: createMockClient().client });
  const badBucket = await cli(
    ['entry', 'aggregate', '--form', 'Kp7mQ2', '--metric', 'avg:field_3', '--by', 'created_at:quarter'],
    { env, client: createMockClient().client }
  );

  assert.equal(noMetric.exitCode, 2);
  assert.match(noMetric.stderr, /--metric <func>:<field> is required/);
  assert.equal(badBucket.exitCode, 2);
  assert.match(badBucket.stderr, /bucket must be day, week, month/);
});

test('entry summary asks for named fields and can drop the overview', async () => {
  const mock = createMockClient();

  await cli(['entry', 'summary', '--form', 'Kp7mQ2', '--fields', 'field_3,field_7', '--no-overview'], {
    env: { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' },
    client: mock.client
  });

  assert.equal(mock.requests[0].path,
    '/api/v1/forms/Kp7mQ2/entries/summary?fields=field_3%2Cfield_7&include_overview=false');
});

const WRITE_ENV = { JINSHUJU_API_KEY: 'key', JINSHUJU_API_SECRET: 'secret' };

test('field verbs all ride on the container PATCH, each in its own operation', async () => {
  const add = createMockClient();
  const update = createMockClient();
  const choices = createMockClient();
  const remove = createMockClient();

  await cli(['field', 'add', '--form', 'Kp7mQ2', '--json', '{"type":"TextField","label":"备注"}'],
    { env: WRITE_ENV, client: add.client });
  await cli(['field', 'update', '--table', 'Vn4xR8', 'field_3', '--json', '{"required":true}'],
    { env: WRITE_ENV, client: update.client });
  await cli(['field', 'update-choices', '--form', 'Kp7mQ2', 'field_7', '--json', '{"add":[{"label":"丙"}]}'],
    { env: WRITE_ENV, client: choices.client });
  await cli(['field', 'remove', '--form', 'Kp7mQ2', 'field_9', '--yes'],
    { env: WRITE_ENV, client: remove.client });

  assert.equal(add.requests[0].method, 'PATCH');
  assert.equal(add.requests[0].path, '/api/v1/forms/Kp7mQ2');
  assert.deepEqual(add.requests[0].body, { fields: { add: [{ type: 'TextField', label: '备注' }] } });
  assert.equal(update.requests[0].path, '/api/v1/tables/Vn4xR8');
  assert.deepEqual(update.requests[0].body, { fields: { update: [{ required: true, api_code: 'field_3' }] } });
  assert.deepEqual(choices.requests[0].body,
    { fields: { update_choices: [{ add: [{ label: '丙' }], field_api_code: 'field_7' }] } });
  assert.deepEqual(remove.requests[0].body, { fields: { remove: ['field_9'] } });
});

test('a delete refuses until it is confirmed', async () => {
  const mock = createMockClient();
  const guarded = await cli(['entry', 'delete', '--form', 'Kp7mQ2', '12'], { env: WRITE_ENV, client: mock.client });
  const gone = await cli(['entry', 'delete', '--form', 'Kp7mQ2', '12', '--yes'], { env: WRITE_ENV, client: mock.client });

  assert.equal(guarded.exitCode, 2);
  assert.match(guarded.stderr, /pass --yes/);
  assert.equal(mock.requests.length, 1);
  assert.equal(gone.exitCode, 0);
  assert.equal(mock.requests[0].method, 'DELETE');
  assert.equal(mock.requests[0].path, '/api/v1/forms/Kp7mQ2/entries/12');
});

test('entry update merges, --replace writes the whole entry, --batch does neither alone', async () => {
  const patch = createMockClient();
  const put = createMockClient();
  const batch = createMockClient();

  await cli(['entry', 'update', '--form', 'Kp7mQ2', '12', '--json', '{"field_1":"李四"}'],
    { env: WRITE_ENV, client: patch.client });
  await cli(['entry', 'update', '--form', 'Kp7mQ2', '12', '--replace', '--json', '{"field_1":"李四"}'],
    { env: WRITE_ENV, client: put.client });
  await cli(['entry', 'update', '--table', 'Vn4xR8', '--batch', '[{"serial_number":1,"entry":{"field_1":"甲"}}]'],
    { env: WRITE_ENV, client: batch.client });

  assert.equal(patch.requests[0].method, 'PATCH');
  assert.equal(put.requests[0].method, 'PUT');
  // A table batches through the forms path, the only one that serves it.
  assert.equal(batch.requests[0].path, '/api/v1/forms/Vn4xR8/entries/batch');
  assert.deepEqual(batch.requests[0].body, { entries: [{ serial_number: 1, entry: { field_1: '甲' } }] });
});

test('entry update refuses a serial and --replace alongside --batch', async () => {
  const withSerial = await cli(['entry', 'update', '--form', 'Kp7mQ2', '12', '--batch', '[]'],
    { env: WRITE_ENV, client: createMockClient().client });
  const withReplace = await cli(['entry', 'update', '--form', 'Kp7mQ2', '--replace', '--batch', '[]'],
    { env: WRITE_ENV, client: createMockClient().client });

  assert.equal(withSerial.exitCode, 2);
  assert.match(withSerial.stderr, /carries its own serial numbers/);
  assert.equal(withReplace.exitCode, 2);
  assert.match(withReplace.stderr, /--replace cannot be combined with --batch/);
});

test('view create turns its flags into the body the API reads', async () => {
  const mock = createMockClient();

  await cli(['view', 'create', '--form', 'Kp7mQ2', '高分', '--type', 'grid',
    '--columns', 'field_1,field_3', '--sort', 'created_at:desc', '--filter', 'field_3 gte 80'],
    { env: WRITE_ENV, client: mock.client });

  assert.equal(mock.requests[0].method, 'POST');
  assert.equal(mock.requests[0].path, '/api/v1/forms/Kp7mQ2/views');
  assert.deepEqual(mock.requests[0].body, {
    view_type: 'grid',
    prefer_columns: ['field_1', 'field_3'],
    sort: [{ api_code: 'created_at', order: 'desc' }],
    filter: [{ field: 'field_3', operator: 'gte', value: '80' }],
    name: '高分'
  });
});

test('a comment is addressed through its entry, and a reply names its parent', async () => {
  const create = createMockClient();
  const noEntry = await cli(['comment', 'update', '--form', 'Kp7mQ2', 'c1', '改一下'],
    { env: WRITE_ENV, client: createMockClient().client });

  await cli(['comment', 'create', '--form', 'Kp7mQ2', '--entry', '12', '收到', '--reply-to', 'c1'],
    { env: WRITE_ENV, client: create.client });

  assert.equal(create.requests[0].path, '/api/v1/forms/Kp7mQ2/entries/12/comments');
  assert.deepEqual(create.requests[0].body, { content: '收到', parent_id: 'c1' });
  assert.equal(noEntry.exitCode, 2);
  assert.match(noEntry.stderr, /--entry <serial> is required/);
});

test('form move sends an empty folder when none is named, which is how it leaves one', async () => {
  const into = createMockClient();
  const out = createMockClient();

  await cli(['form', 'move', 'Kp7mQ2', '--folder', 'Fd2xK8'], { env: WRITE_ENV, client: into.client });
  await cli(['form', 'move', 'Kp7mQ2'], { env: WRITE_ENV, client: out.client });

  assert.deepEqual(into.requests[0].body, { folder_token: 'Fd2xK8' });
  assert.deepEqual(out.requests[0].body, { folder_token: '' });
});

test('opensearch edit turns a query on or off, but not both', async () => {
  const off = createMockClient();
  await cli(['opensearch', 'edit', 'Qy7nR3', '--disable'], { env: WRITE_ENV, client: off.client });
  const both = await cli(['opensearch', 'edit', 'Qy7nR3', '--enable', '--disable'],
    { env: WRITE_ENV, client: createMockClient().client });

  assert.deepEqual(off.requests[0].body, { enabled: false });
  assert.equal(both.exitCode, 2);
  assert.match(both.stderr, /--enable and --disable are opposites/);
});

test('several --name keywords stay separate, so the API matches any of them', async () => {
  const forms = createMockClient();
  const tables = createMockClient();

  await cli(['form', 'list', '--name', '报名', '--name', '问卷'], { env: WRITE_ENV, client: forms.client });
  await cli(['table', 'list', '--name', '台账'], { env: WRITE_ENV, client: tables.client });

  assert.equal(forms.requests[0].path, '/api/v1/forms?q%5B%5D=%E6%8A%A5%E5%90%8D&q%5B%5D=%E9%97%AE%E5%8D%B7');
  assert.equal(tables.requests[0].path, '/api/v1/tables?q%5B%5D=%E5%8F%B0%E8%B4%A6');
});

test('--labels is asked for on the entry reads, and left off otherwise', async () => {
  const listed = createMockClient();
  const got = createMockClient();
  const viewed = createMockClient();
  const bare = createMockClient();

  await cli(['entry', 'list', '--form', 'Kp7mQ2', '--labels'], { env: WRITE_ENV, client: listed.client });
  await cli(['entry', 'get', '--form', 'Kp7mQ2', '12', '--labels'], { env: WRITE_ENV, client: got.client });
  await cli(['entry', 'list', '--form', 'Kp7mQ2', '--view', 'aB3dE9', '--labels'], { env: WRITE_ENV, client: viewed.client });
  await cli(['entry', 'list', '--form', 'Kp7mQ2'], { env: WRITE_ENV, client: bare.client });

  assert.equal(listed.requests[0].path, '/api/v1/forms/Kp7mQ2/entries?include_labels=true');
  assert.equal(got.requests[0].path, '/api/v1/forms/Kp7mQ2/entries/12?include_labels=true');
  assert.equal(viewed.requests[0].path, '/api/v1/forms/Kp7mQ2/views/aB3dE9/entries?include_labels=true');
  assert.equal(bare.requests[0].path, '/api/v1/forms/Kp7mQ2/entries');
});

test('table move and --with-default-entries reach their own endpoints', async () => {
  const moved = createMockClient();
  const rooted = createMockClient();
  const seeded = createMockClient();

  await cli(['table', 'move', 'Vn4xR8', '--folder', 'Nf7mDC'], { env: WRITE_ENV, client: moved.client });
  await cli(['table', 'move', 'Vn4xR8'], { env: WRITE_ENV, client: rooted.client });
  await cli(['table', 'create', '--json', '{"name":"台账","fields":[]}', '--with-default-entries'],
    { env: WRITE_ENV, client: seeded.client });

  assert.equal(moved.requests[0].method, 'PATCH');
  assert.equal(moved.requests[0].path, '/api/v1/tables/Vn4xR8/folder');
  assert.deepEqual(moved.requests[0].body, { folder_token: 'Nf7mDC' });
  assert.deepEqual(rooted.requests[0].body, { folder_token: '' });
  assert.deepEqual(seeded.requests[0].body, { name: '台账', fields: [], with_default_entries: true });
});

test('form get --include names the blocks, and setting is honoured by already being there', async () => {
  const asked = createMockClient();
  const settingOnly = createMockClient();

  await cli(['form', 'get', 'Kp7mQ2', '--include', 'theme,rules,extended,transactions,analytics'],
    { env: WRITE_ENV, client: asked.client });
  await cli(['form', 'get', 'Kp7mQ2', '--include', 'setting'], { env: WRITE_ENV, client: settingOnly.client });
  const unknown = await cli(['form', 'get', 'Kp7mQ2', '--include', 'wallpaper'],
    { env: WRITE_ENV, client: createMockClient().client });

  const query = new URL(asked.requests[0].path, 'https://x').searchParams;
  assert.deepEqual([...query.keys()].sort(),
    ['include_analytics', 'include_extended_attributes', 'include_field_rules', 'include_theme', 'include_transactions']);
  assert.equal(settingOnly.requests[0].path, '/api/v1/forms/Kp7mQ2');
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.stderr, /--include takes setting, theme, rules, extended, transactions, analytics/);
});

test('form list asks for transaction totals only when told to', async () => {
  const withTotals = createMockClient();
  const without = createMockClient();

  await cli(['form', 'list', '--with-transactions'], { env: WRITE_ENV, client: withTotals.client });
  await cli(['form', 'list'], { env: WRITE_ENV, client: without.client });

  assert.equal(withTotals.requests[0].path, '/api/v1/forms?include_transactions=true');
  assert.equal(without.requests[0].path, '/api/v1/forms');
});

test('field check batches its targets, from arguments and from --json alike', async () => {
  const plain = createMockClient();
  const mixed = createMockClient();

  await cli(['field', 'check', '--form', 'Kp7mQ2', 'field_3', 'field_7:choice_1'],
    { env: WRITE_ENV, client: plain.client });
  await cli(['field', 'check', '--table', 'Vn4xR8', 'field_3',
    '--json', '[{"field_api_code":"field_9","choice_value":"s1","choice_type":"statement"}]'],
    { env: WRITE_ENV, client: mixed.client });
  const empty = await cli(['field', 'check', '--form', 'Kp7mQ2'],
    { env: WRITE_ENV, client: createMockClient().client });

  const checks = (path: string) => JSON.parse(new URL(path, 'https://x').searchParams.get('checks') as string);
  assert.deepEqual(checks(plain.requests[0].path),
    [{ field_api_code: 'field_3' }, { field_api_code: 'field_7', choice_value: 'choice_1' }]);
  assert.deepEqual(checks(mixed.requests[0].path),
    [{ field_api_code: 'field_3' },
     { field_api_code: 'field_9', choice_value: 's1', choice_type: 'statement' }]);
  assert.equal(empty.exitCode, 2);
  assert.match(empty.stderr, /name at least one target/);
});

test('field preview-convert asks about one conversion, and needs a target type', async () => {
  const mock = createMockClient();

  await cli(['field', 'preview-convert', '--form', 'Kp7mQ2', 'field_1', '--to', 'RadioButton'],
    { env: WRITE_ENV, client: mock.client });
  const noType = await cli(['field', 'preview-convert', '--form', 'Kp7mQ2', 'field_1'],
    { env: WRITE_ENV, client: createMockClient().client });

  const checks = JSON.parse(new URL(mock.requests[0].path, 'https://x').searchParams.get('checks') as string);
  assert.equal(mock.requests[0].path.split('?')[0], '/api/v1/forms/Kp7mQ2/fields/preview_convert');
  assert.deepEqual(checks, [{ field_api_code: 'field_1', target_type: 'RadioButton' }]);
  assert.equal(noType.exitCode, 2);
  assert.match(noType.stderr, /--to is required/);
});

test('entry search names its containers, or describes them with --scope-filter', async () => {
  const named = createMockClient();
  const described = createMockClient();
  const everything = createMockClient();

  await cli(['entry', 'search', '某某公司', '--form', 'Kp7mQ2', '--form', 'aB3dE9'],
    { env: WRITE_ENV, client: named.client });
  await cli(['entry', 'search', '报修', '--scope-filter', 'entries_count gt 100'],
    { env: WRITE_ENV, client: described.client });
  await cli(['entry', 'search', '张三'], { env: WRITE_ENV, client: everything.client });
  const mixed = await cli(['entry', 'search', '张三', '--form', 'Kp7mQ2', '--table', 'Vn4xR8'],
    { env: WRITE_ENV, client: createMockClient().client });

  const query = (path: string) => new URL(path, 'https://x').searchParams;
  assert.equal(query(named.requests[0].path).get('form_tokens'), 'Kp7mQ2,aB3dE9');
  assert.equal(query(described.requests[0].path).get('filters'),
    '[{"field":"entries_count","operator":"gt","value":"100"}]');
  // No container and no scope filter means every form the caller can reach.
  assert.equal(everything.requests[0].path, '/api/v1/entries/search?keyword=%E5%BC%A0%E4%B8%89');
  assert.equal(mixed.exitCode, 2);
  assert.match(mixed.stderr, /--form and --table are mutually exclusive/);
});

test('--mine switches all three reads to what the caller submitted', async () => {
  const forms = createMockClient();
  const entries = createMockClient();
  const search = createMockClient();

  await cli(['form', 'list', '--mine'], { env: WRITE_ENV, client: forms.client });
  await cli(['entry', 'list', '--form', 'Kp7mQ2', '--mine', '--keyword', '报修'],
    { env: WRITE_ENV, client: entries.client });
  await cli(['entry', 'search', '某某公司', '--mine', '--form', 'Kp7mQ2'],
    { env: WRITE_ENV, client: search.client });

  assert.equal(forms.requests[0].path, '/api/v1/my/forms');
  assert.equal(entries.requests[0].path, '/api/v1/my/forms/Kp7mQ2/entries?keyword=%E6%8A%A5%E4%BF%AE');
  assert.equal(search.requests[0].path,
    '/api/v1/my/search?keyword=%E6%9F%90%E6%9F%90%E5%85%AC%E5%8F%B8&form_tokens=Kp7mQ2');
});

test('--mine refuses the flags that only make sense on the owner side', async () => {
  const env = WRITE_ENV;
  const sorted = await cli(['form', 'list', '--mine', '--sort', 'entries_count:desc'],
    { env, client: createMockClient().client });
  const viewed = await cli(['entry', 'list', '--form', 'Kp7mQ2', '--mine', '--view', 'aB3dE9'],
    { env, client: createMockClient().client });
  const scoped = await cli(['entry', 'search', '张三', '--mine', '--scope-filter', 'entries_count gt 1'],
    { env, client: createMockClient().client });

  assert.equal(sorted.exitCode, 2);
  assert.match(sorted.stderr, /--sort cannot be combined with --mine/);
  assert.equal(viewed.exitCode, 2);
  assert.match(viewed.stderr, /--view cannot be combined with --mine/);
  assert.equal(scoped.exitCode, 2);
  assert.match(scoped.stderr, /--scope-filter cannot be combined with --mine/);
});

function uploadingClient(responses: Record<string, unknown>) {
  const requests: HttpRequest[] = [];
  return {
    requests,
    client: {
      async request<T>(request: HttpRequest): Promise<T> {
        requests.push(request);
        const key = Object.keys(responses).find((path) => request.path.startsWith(path));
        return (key ? responses[key] : { ok: true }) as T;
      }
    }
  };
}

test('entry import sends the file, then the mapping that refers to it', async () => {
  const mock = uploadingClient({ '/api/v1/forms/Kp7mQ2/import_files': { id: 'att_1' } });

  const result = await cli(
    ['entry', 'import', '--form', 'Kp7mQ2', 'package.json', '--map', 'field_1=姓名', '--map', 'field_2=3', '--header-row', '2'],
    { env: WRITE_ENV, client: mock.client }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].path, '/api/v1/forms/Kp7mQ2/import_files');
  assert.ok(mock.requests[0].form instanceof FormData);
  assert.deepEqual(mock.requests[1].body, {
    attachment_id: 'att_1',
    columns: [{ field_api_code: 'field_1', column_label: '姓名' },
              { field_api_code: 'field_2', sheet_column_index: 3 }],
    header_row_index: 2
  });
});

test('entry import needs a mapping, and names a file it cannot read', async () => {
  const noMap = await cli(['entry', 'import', '--form', 'Kp7mQ2', 'package.json'],
    { env: WRITE_ENV, client: uploadingClient({}).client });
  const missing = await cli(['entry', 'import', '--form', 'Kp7mQ2', 'nosuch.xlsx', '--map', 'field_1=A'],
    { env: WRITE_ENV, client: uploadingClient({}).client });

  assert.equal(noMap.exitCode, 2);
  assert.match(noMap.stderr, /--map <api-code>=<column> is required/);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /could not read nosuch.xlsx/);
});

test('entry create uploads each --attach and fills the field with what came back', async () => {
  const mock = uploadingClient({ '/api/v1/forms/Kp7mQ2/entry_attachments': { id: 'file_1' } });

  await cli(['entry', 'create', '--form', 'Kp7mQ2', '--json', '{"field_1":"张三"}', '--attach', 'field_5=package.json'],
    { env: WRITE_ENV, client: mock.client });

  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].path, '/api/v1/forms/Kp7mQ2/entry_attachments');
  assert.deepEqual(mock.requests[1].body, { field_1: '张三', field_5: ['file_1'] });
});

test('entry create without --attach is still one request', async () => {
  const mock = uploadingClient({});

  await cli(['entry', 'create', '--form', 'Kp7mQ2', '--json', '{"field_1":"张三"}'],
    { env: WRITE_ENV, client: mock.client });

  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].path, '/api/v1/forms/Kp7mQ2/entries');
});

test('form theme set uploads an image and hands the theme its id', async () => {
  const mock = uploadingClient({ '/api/v1/form_image_attachments': { attachment_id: 'img_1' } });

  await cli(['form', 'theme', 'set', 'Kp7mQ2', '--wallpaper', 'package.json', '--primary-color', '#1F6FEB'],
    { env: WRITE_ENV, client: mock.client });

  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].path, '/api/v1/form_image_attachments');
  assert.deepEqual(mock.requests[1].body, {
    primary_color: '#1F6FEB',
    wallpaper: { background_image_attachment_id: 'img_1' }
  });
});

test('form create carries the scene, layout and folder the design asks for', async () => {
  const mock = createMockClient();
  const bare = createMockClient();

  await cli(['form', 'create', '--json', '{"name":"考试","fields":[{"type":"TextField","label":"姓名"}]}',
    '--scene', 'exam', '--layout', 'card', '--folder', 'Fd2xK8'], { env: WRITE_ENV, client: mock.client });
  await cli(['form', 'create', '--json', '{"name":"普通","fields":[{"type":"TextField","label":"姓名"}]}'],
    { env: WRITE_ENV, client: bare.client });
  const unknownScene = await cli(['form', 'create', '--json', '{"name":"x","fields":[]}', '--scene', 'picnic'],
    { env: WRITE_ENV, client: createMockClient().client });

  assert.deepEqual(mock.requests[0].body, {
    name: '考试', fields: [{ type: 'TextField', label: '姓名' }],
    scene: 'exam', layout: 'card', folder_token: 'Fd2xK8'
  });
  // An absent flag sends nothing, rather than a key asking for the default.
  assert.deepEqual(bare.requests[0].body, { name: '普通', fields: [{ type: 'TextField', label: '姓名' }] });
  assert.equal(unknownScene.exitCode, 2);
});

test('--type picks the scene, and refuses a --scene that contradicts it', async () => {
  const exam = createMockClient();

  await cli(['form', 'create', '--json', '{"name":"考试","fields":[{"type":"TextField","label":"姓名"}]}', '--type', 'exam'],
    { env: WRITE_ENV, client: exam.client });
  const clash = await cli(['form', 'create', '--type', 'exam', '--scene', 'registry',
    '--json', '{"name":"x","fields":[{"type":"TextField","label":"姓名"}]}'],
    { env: WRITE_ENV, client: createMockClient().client });

  assert.equal((exam.requests[0].body as Record<string, unknown>).scene, 'exam');
  assert.equal(clash.exitCode, 2);
  assert.match(clash.stderr, /--type exam is the exam scene, so --scene registry contradicts it/);
});

test('a settings block travels to its own endpoint, on create and on edit', async () => {
  const created = uploadingClient({ '/api/v1/forms': { token: 'Kp7mQ2' } });
  const edited = createMockClient();
  const editedBoth = createMockClient();

  await cli(['form', 'create', '--type', 'exam',
    '--json', '{"name":"考试","fields":[{"type":"TextField","label":"姓名"}],"exam_setting":{"total_score":100}}'],
    { env: WRITE_ENV, client: created.client });
  await cli(['form', 'edit', 'Kp7mQ2', '--json', '{"exam_setting":{"total_score":90}}'],
    { env: WRITE_ENV, client: edited.client });
  await cli(['form', 'edit', 'Kp7mQ2', '--json', '{"name":"改名","exam_setting":{"total_score":90}}'],
    { env: WRITE_ENV, client: editedBoth.client });

  // Created without the block, then the block to its own path.
  assert.equal(created.requests[0].path, '/api/v1/forms');
  assert.equal((created.requests[0].body as Record<string, unknown>).exam_setting, undefined);
  assert.equal(created.requests[1].path, '/api/v1/forms/Kp7mQ2/exam_setting');
  assert.deepEqual(created.requests[1].body, { total_score: 100 });

  // A block on its own never touches the generic update, which would drop it.
  assert.equal(edited.requests.length, 2);
  assert.equal(edited.requests[0].path, '/api/v1/forms/Kp7mQ2/exam_setting');
  assert.equal(edited.requests[1].method, 'GET');

  // Alongside other changes, the block goes first: a refusal then leaves the
  // rest of the edit unapplied rather than half done.
  assert.equal(editedBoth.requests[0].path, '/api/v1/forms/Kp7mQ2/exam_setting');
  assert.deepEqual(editedBoth.requests[1].body, { name: '改名' });
});

test('an edit with no settings block is still one request', async () => {
  const mock = createMockClient();

  await cli(['form', 'edit', 'Kp7mQ2', '--json', '{"name":"改名"}'], { env: WRITE_ENV, client: mock.client });

  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].method, 'PATCH');
  assert.equal(mock.requests[0].path, '/api/v1/forms/Kp7mQ2');
});
