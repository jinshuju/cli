import test from 'node:test';
import assert from 'node:assert/strict';

import { UsageError, parseFilter, parseSort, readJsonInput, resolveContainer } from './options.js';

// The three examples the command design gives for --filter, verbatim.
test('--filter accepts the forms the design documents', () => {
  assert.deepEqual(parseFilter('field_3 gte 80'), { field: 'field_3', operator: 'gte', value: '80' });
  assert.deepEqual(parseFilter('created_at within_last 30d'), {
    field: 'created_at',
    operator: 'within_last',
    value: { unit: 'day', n: 30 }
  });
  assert.deepEqual(parseFilter('field_4 between 1,10'), { field: 'field_4', operator: 'between', value: ['1', '10'] });
});

// The server converts a condition value by the field's own type, so a value
// that looks numeric is left as text and a phone number keeps its digits.
test('--filter leaves values as text for the server to convert', () => {
  assert.equal(parseFilter('field_2 eq 13800138000').value, '13800138000');
  assert.equal(parseFilter('field_1 like 张').value, '张');
});

test('--filter builds the shapes the operators need', () => {
  assert.deepEqual(parseFilter('field_1 any_in 北京,上海').value, ['北京', '上海']);
  assert.deepEqual(parseFilter('field_9 null'), { field: 'field_9', operator: 'null' });
  assert.deepEqual(parseFilter('field_1 any_in 上海\\,浦东,北京').value, ['上海,浦东', '北京']);
  assert.deepEqual(parseFilter('created_at within_last 4w').value, { unit: 'week', n: 4 });
});

test('--filter names the operator meant, and refuses two conditions in one', () => {
  const refused = (input: string) => {
    try {
      parseFilter(input);
    } catch (error) {
      if (error instanceof UsageError) return error.message;
      throw error;
    }
    throw new Error(`${input} was expected to be refused`);
  };
  // What three days of 400s said callers write: =, in, not_empty.
  assert.match(refused('field_1 = 1'), /operator '=' is written 'eq'\. Operators: eq ne any_in/);
  assert.match(refused('field_1 in a,b'), /operator 'in' is written 'any_in'/);
  assert.match(refused('field_9 not_empty'), /operator 'not_empty' is written 'not_null'/);
  assert.match(refused('field_1 EQ 1'), /operator 'EQ' is written 'eq'/);
  assert.match(refused('field_1 near 1'), /operator 'near' is not one\. Operators: /);

  // Two conditions in one flag went as one, the whole tail being the first field's value.
  assert.match(
    refused('field_15 eq S5mp and field_4 equal 通过 and field_2 = 1'),
    /one condition; write the next as its own flag: --filter 'field_15 eq S5mp' --filter 'field_4 equal …'/
  );
  // A value containing "and" is a value, unless a field and an operator follow it.
  assert.equal(parseFilter('field_1 like rock and roll').value, 'rock and roll');
  assert.equal(parseFilter('field_1 eq and').value, 'and');
});

test('--filter takes the quotes off a value written in them', () => {
  assert.deepEqual(parseFilter('created_at between "2026-10-31 00:00:00","2026-10-31 23:59:59"').value, [
    '2026-10-31 00:00:00',
    '2026-10-31 23:59:59'
  ]);
  assert.equal(parseFilter("field_1 eq 'foo bar'").value, 'foo bar');
  assert.deepEqual(parseFilter('field_1 any_in "北京","上海"').value, ['北京', '上海']);
  // A quote inside a value, or on one end only, is text.
  assert.equal(parseFilter('field_1 eq 5\'10"').value, '5\'10"');
  assert.equal(parseFilter('field_1 eq "x').value, '"x');
});

test('--filter refuses what it cannot express rather than guessing', () => {
  assert.throws(() => parseFilter('field_3'), UsageError);
  assert.throws(() => parseFilter('field_3 gte'), UsageError);
  assert.throws(() => parseFilter('field_9 null nope'), UsageError);
  assert.throws(() => parseFilter('field_4 between 1'), UsageError);
  assert.throws(() => parseFilter('created_at within_last 30x'), UsageError);
  assert.throws(() => parseFilter('created_at within_last 0d'), UsageError);
});

test('--sort takes field:order and defaults to asc', () => {
  assert.deepEqual(parseSort('created_at:desc'), { field: 'created_at', order: 'desc' });
  assert.deepEqual(parseSort('entries_count'), { field: 'entries_count', order: 'asc' });
  assert.throws(() => parseSort('created_at:down'), UsageError);
});

test('--json reads inline, a file and stdin', () => {
  assert.deepEqual(
    readJsonInput('{"a":1}', () => ''),
    { a: 1 }
  );
  assert.deepEqual(
    readJsonInput('-', () => '{"b":2}'),
    { b: 2 }
  );
  assert.throws(() => readJsonInput('@/nope/missing.json', () => ''), UsageError);
  assert.throws(() => readJsonInput('{oops', () => ''), UsageError);
});

// Both flags address one API parameter, so guessing between them would read the
// wrong object without saying so.
test('the container must be given, and only one of it', () => {
  assert.deepEqual(resolveContainer({ form: 'q1' }), { token: 'q1', kind: 'form' });
  assert.deepEqual(resolveContainer({ table: 't1' }), { token: 't1', kind: 'table' });
  assert.throws(() => resolveContainer({ form: 'q1', table: 't1' }), UsageError);
  assert.throws(() => resolveContainer({}), UsageError);
});
