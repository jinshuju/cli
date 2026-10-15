import test from 'node:test';
import assert from 'node:assert/strict';

import { UsageError } from './errors.js';
import { withQuery } from './http.js';
import { FORM_IMAGE_TYPES } from './commands/upload.js';
import { BASE_PATH, bodyChoices, call, choices, operation, unansweredLookups, type Schema } from './spec.js';
import { operationOf, validate } from './testing/conformance.js';

test('a request is the operation openapi.yaml names, under the base path, its path parameters encoded', () => {
  const request = call('getEntry', {
    path: { form_token: 'Kp7mQ2', serial_number: 12 },
    query: { include_labels: true }
  });

  assert.equal(BASE_PATH, '/api/v1');
  assert.equal(request.method, 'GET');
  assert.equal(withQuery(request.path, request.query), '/api/v1/forms/Kp7mQ2/entries/12?include_labels=true');
  assert.equal(call('getFillViewPage', { path: { view_token: 'a/b' } }).path, '/api/v1/fill/v/a%2Fb');
});

test('a parameter the operation does not have is refused by name, before anything is sent', () => {
  assert.throws(
    () => call('listFormViewEntries', { path: { form_token: 'Kp7mQ2', view_token: 'aB3dE9' }, query: { limit: 10 } }),
    (error: unknown) => error instanceof UsageError && /takes no limit parameter/.test(error.message)
  );
  // A path parameter that is not there is this code's mistake, not the caller's.
  assert.throws(
    () => call('getForm', { path: { form_token: 'Kp7mQ2', view_token: 'x' } }),
    /no path parameter view_token/
  );
  assert.throws(() => call('getForm'), /needs its path parameter form_token/);
});

test('a parameter is held to its type and to being there, and to nothing a later API could widen', () => {
  const refused = (fn: () => unknown, message: RegExp) =>
    assert.throws(fn, (error: unknown) => error instanceof UsageError && message.test(error.message));

  refused(
    () => call('getEntry', { path: { form_token: 'Kp7mQ2', serial_number: 'abc' } }),
    /^serial_number must be an integer, got "abc"$/
  );
  refused(() => call('listTradeTransactions', { query: { next: 'page-two' } }), /^next must be an integer/);
  refused(() => call('getEntryStats'), /^from is required/);

  // A limit, a length or a list of values may grow in a later API; the server judges those.
  assert.ok(call('listFolders', { query: { limit: 500 } }));
  assert.ok(call('listTradeRefunds', { query: { status: 'reversed' } }));
  assert.ok(call('listEntries', { path: { form_token: 'Kp7mQ2' }, query: { keyword: 'x'.repeat(201) } }));
});

test('a list goes on the wire as its parameter says: comma-joined when it does not explode, repeated otherwise', () => {
  const statuses = call('listTradeTransactions', { query: { paid_status: ['paid', 'refunded'] } });
  assert.equal(withQuery(statuses.path, statuses.query), '/api/v1/trade/transactions?paid_status=paid%2Crefunded');

  // `q` is a string in the schema, and the spec's prose lets it repeat.
  const names = call('listForms', { query: { q: ['报名', '反馈'] } });
  assert.equal(
    withQuery(names.path, names.query),
    `/api/v1/forms?${new URLSearchParams([
      ['q[]', '报名'],
      ['q[]', '反馈']
    ])}`
  );
});

test('a body goes as given, for the API to judge against the spec it runs', () => {
  // A key this copy of the spec has never heard of may be one the API has
  // learned since this CLI was installed; the request still leaves.
  const body = { name: 'x', fields: [{ type: 'TextField', label: 'a', future_option: true }] };
  assert.deepEqual(call('createForm', { body }).body, body);

  assert.throws(() => call('getForm', { path: { form_token: 'Kp7mQ2' }, body: {} }), /takes no JSON body/);
  assert.throws(() => call('createFolder'), /needs a request body/);
});

test('flags read their values off the spec rather than a copy of it', () => {
  assert.deepEqual(choices('getEntryStats', 'by'), ['day', 'week', 'month']);
  assert.ok(choices('listTradeTransactions', 'paid_status')?.includes('partial_refunded'));
  // The copies these replaced had fallen behind: no form view, no form or quickpay scene.
  assert.ok(bodyChoices('createFormView', 'view_type')?.includes('form'));
  assert.ok(bodyChoices('createForm', 'scene')?.includes('quickpay'));
  assert.ok(bodyChoices('createTable', 'fields[].type')?.includes('TextArea'));
  assert.deepEqual(bodyChoices('createFolder', 'kind'), ['form', 'table']);
  // A list the spec does not give leaves the flag open, and is noted for the test that loads the commands.
  assert.equal(choices('listFolders', 'limit'), undefined);
  assert.equal(bodyChoices('createFolder', 'colour'), undefined);
  assert.deepEqual(unansweredLookups(), ['listFolders limit', 'createFolder colour']);
});

test('the image types the CLI uploads as are ones the spec lists', () => {
  const multipart = operation('uploadFormImage').body?.content['multipart/form-data'];
  const imageType = multipart?.properties?.image_type as Schema | undefined;
  for (const type of FORM_IMAGE_TYPES) assert.ok(imageType?.enum?.includes(type), type);
});

test('a request is traced back to its operation, a literal segment before a parameter', () => {
  assert.equal(operationOf({ method: 'GET', path: '/api/v1/forms/Kp7mQ2/entries/count' }), 'countEntries');
  assert.equal(operationOf({ method: 'GET', path: '/api/v1/forms/Kp7mQ2/entries/12' }), 'getEntry');
  assert.equal(operationOf({ method: 'PATCH', path: '/api/v1/forms/Kp7mQ2/entries/batch' }), 'patchEntriesBatch');
  assert.equal(operationOf({ method: 'GET', path: '/api/v1/nowhere' }), undefined);
  assert.equal(operationOf({ method: 'GET', path: '/elsewhere/forms' }), undefined);
});

test('the check the tests hold requests to knows the keywords the generator keeps', () => {
  const schema: Schema = {
    type: 'object',
    required: ['kind'],
    additionalProperties: false,
    properties: {
      kind: { enum: ['a', 'b'] },
      size: { type: 'integer', minimum: 1 },
      tags: { type: 'array', maxItems: 2, items: { type: 'string', pattern: '^[a-z]+$' } },
      shape: { oneOf: [{ type: 'string' }, { type: 'object', required: ['id'] }] }
    },
    if: { properties: { kind: { const: 'b' } } },
    // oxlint-disable-next-line unicorn/no-thenable -- a JSON Schema keyword, never awaited
    then: { required: ['size'] }
  };
  const messages = (value: unknown) => validate(schema, value).map((issue) => `${issue.pointer} ${issue.message}`);

  assert.deepEqual(messages({ kind: 'a' }), []);
  assert.deepEqual(messages({ kind: 'b' }), ['/size is required']);
  assert.deepEqual(messages({ kind: 'c', size: 0, extra: 1 }), [
    '/kind must be one of a, b',
    '/size must be at least 1',
    '/extra is not a key it takes'
  ]);
  assert.deepEqual(messages({ kind: 'a', tags: ['ok', 'No', 'x'] }), [
    '/tags must have at most 2 items',
    '/tags/1 must match ^[a-z]+$'
  ]);
  assert.deepEqual(messages({ kind: 'a', shape: {} }), ['/shape/id is required']);
  assert.deepEqual(messages([]), [' must be object']);
});
