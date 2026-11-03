import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from './cli.js';
import { SPEC_DATE } from './generated/operations.js';
import type { HttpRequest } from './http.js';
import { preflight } from './preflight.js';
import { call } from './spec.js';

const NO_CONFIG = join(mkdtempSync(join(tmpdir(), 'jsj-preflight-')), 'config.json');
const ENV = { JINSHUJU_ACCESS_TOKEN: 'tok' };

/** A client that answers everything and keeps what reached it. */
function recording() {
  const requests: HttpRequest[] = [];
  return {
    requests,
    client: {
      async request<T>(request: HttpRequest): Promise<T> {
        requests.push(request);
        return { ok: true } as T;
      }
    }
  };
}

function field(json: string, verb = 'update') {
  const words = verb === 'add' ? ['field', 'add', '--form', 'Kp7mQ2'] : ['field', verb, '--form', 'Kp7mQ2', 'field_3'];
  return [...words, '--json', json, '--config', NO_CONFIG];
}

test('a field written back as it was read is refused before it is sent, with the payload that would do', async () => {
  const mock = recording();
  const result = await runCli(field('{"validation":{"required":true,"unique":false,"white_list_values":["a"]}}'), {
    env: ENV,
    client: mock.client
  });

  assert.equal(result.exitCode, 2);
  assert.equal(mock.requests.length, 0);
  assert.match(result.stderr, new RegExp(`by the openapi.yaml of ${SPEC_DATE} this CLI shipped with:`));
  assert.match(
    result.stderr,
    /\/fields\/update\/0\/validation: validation is how a field reads, not how it is written/
  );
  assert.match(result.stderr, /write its keys flat on the field: \{"required":true,"unique":false\}/);
  assert.match(result.stderr, /leave out white_list_values, which a write does not take/);
  assert.match(result.stderr, /Nothing was sent\. --as-is sends it anyway/);
});

test('null for a key the spec does not let be null is refused, and the key read as null is named', async () => {
  const mock = recording();
  const patched = await runCli(field('{"range_min":null,"placeholder":null,"label":"ok"}'), {
    env: ENV,
    client: mock.client
  });
  assert.equal(patched.exitCode, 2);
  assert.match(patched.stderr, /\/fields\/update\/0\/range_min: is null; leave the key out to leave it unchanged/);
  assert.match(patched.stderr, /\/fields\/update\/0\/placeholder: is null; leave the key out to leave it unchanged/);

  // A key the spec does let be null goes: a choice's quota, which null takes off.
  const nullable = await runCli(field('{"update":[{"api_code":"c1","quota":null}]}', 'update-choices'), {
    env: ENV,
    client: mock.client
  });
  assert.equal(nullable.exitCode, 0, nullable.stderr);
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(mock.requests[0]?.body, {
    fields: { update_choices: [{ update: [{ api_code: 'c1', quota: null }], field_api_code: 'field_3' }] }
  });
});

test('a choice to update without its api_code, and choices on a field update, are refused with the way in', async () => {
  const mock = recording();
  const choices = await runCli(
    field('{"update":[{"value":"a","quota":3}],"add":[{"name":"c","position":1}]}', 'update-choices'),
    { env: ENV, client: mock.client }
  );
  assert.equal(choices.exitCode, 2);
  assert.match(
    choices.stderr,
    /\/fields\/update_choices\/0\/update\/0\/api_code: is required; a choice to update is named by its api_code/
  );
  // position is a key this copy of the spec does not list, which the API may have learned: not this check's to refuse.
  assert.doesNotMatch(choices.stderr, /position/);

  const onUpdate = await runCli(field('{"choices":[{"name":"x"}]}'), { env: ENV, client: mock.client });
  assert.equal(onUpdate.exitCode, 2);
  assert.match(
    onUpdate.stderr,
    /\/fields\/update\/0\/choices: choices are not changed on update; change them with `jinshuju field update-choices/
  );
  assert.equal(mock.requests.length, 0);
});

test('what a newer spec may take is sent: an unknown key, an unknown value, an unknown field type, a longer list', async () => {
  const mock = recording();
  const sent = await Promise.all([
    runCli(field('{"label":"x","future_option":true}'), { env: ENV, client: mock.client }),
    runCli(field('{"type":"LikertField","label":"x","likert_choice_style":"future"}', 'add'), {
      env: ENV,
      client: mock.client
    }),
    runCli(field('{"type":"HologramField","label":"h","depth":3}', 'add'), { env: ENV, client: mock.client }),
    runCli(['comment', 'create', '--form', 'Kp7mQ2', '--entry', '12', 'x'.repeat(2001), '--config', NO_CONFIG], {
      env: ENV,
      client: mock.client
    })
  ]);
  assert.deepEqual(
    sent.map((result) => result.exitCode),
    [0, 0, 0, 0]
  );
  assert.equal(mock.requests.length, 4);
});

test('a field of a known type is held to that type alone, as its own `type` names it', () => {
  // The server's validation told a LikertField with a stray key about the
  // table's field types as well, and the caller went off to change a type
  // that was right. Here the discriminator picks the shape, and the stray
  // key is the only thing said — and, being a key, not refused.
  const likert = call('updateForm', {
    path: { form_token: 'Kp7mQ2' },
    body: { fields: { add: [{ type: 'LikertField', label: 'x', validation: { required: true } }] } }
  });
  assert.deepEqual(preflight(likert), [
    {
      pointer: '/fields/add/0/validation',
      message:
        'validation is how a field reads, not how it is written; write its keys flat on the field: {"required":true}'
    }
  ]);

  // A required key of the shape the type names is refused; the same key under a type this copy does not know is not.
  const noLabel = call('updateForm', {
    path: { form_token: 'Kp7mQ2' },
    body: { fields: { add: [{ type: 'TextField' }] } }
  });
  assert.deepEqual(preflight(noLabel), [{ pointer: '/fields/add/0/label', message: 'is required' }]);
  const unknown = call('updateForm', {
    path: { form_token: 'Kp7mQ2' },
    body: { fields: { add: [{ type: 'HologramField' }] } }
  });
  assert.deepEqual(preflight(unknown), []);

  // A shape guessed at (anyOf) is not certain enough to refuse on: a choice naming neither value nor name goes.
  const neither = call('updateForm', {
    path: { form_token: 'Kp7mQ2' },
    body: { fields: { update_choices: [{ field_api_code: 'field_3', add: [{ quota: 2 }] }] } }
  });
  assert.deepEqual(preflight(neither), []);
});

test('a form with page breaks that does not start with one is refused, as the API would refuse it', async () => {
  const mock = recording();
  const result = await runCli(
    [
      'form',
      'create',
      '--json',
      '{"name":"x","fields":[{"type":"TextField","label":"a"},{"type":"PageBreak","label":"p"}]}',
      '--config',
      NO_CONFIG
    ],
    { env: ENV, client: mock.client }
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /\/fields\/0: a form with page breaks starts with one; put a PageBreak first/);
  assert.equal(mock.requests.length, 0);
});

test('--as-is sends the body anyway, and --output json carries each refusal at its pointer', async () => {
  const mock = recording();
  const asIs = await runCli([...field('{"range_min":null}'), '--as-is'], { env: ENV, client: mock.client });
  assert.equal(asIs.exitCode, 0, asIs.stderr);
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(mock.requests[0]?.body, { fields: { update: [{ range_min: null, api_code: 'field_3' }] } });

  const json = await runCli([...field('{"range_min":null,"validation":{"required":true}}'), '--output', 'json'], {
    env: ENV,
    client: mock.client
  });
  assert.equal(json.exitCode, 2);
  const envelope = JSON.parse(json.stderr) as {
    error: { kind: string; errors: { pointer: string; message: string }[] };
  };
  assert.equal(envelope.error.kind, 'usage');
  assert.deepEqual(
    envelope.error.errors.map((refusal) => refusal.pointer),
    ['/fields/update/0/range_min', '/fields/update/0/validation']
  );
});
