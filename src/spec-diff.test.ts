import test from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

/**
 * scripts/spec-diff.mjs titles the spec-sync pull request, and the title is
 * what decides whether a sync releases. Each case is the spec in this checkout
 * with one thing changed, compared against it as it is.
 */

type Node = Record<string, any>;

const root = new URL('..', import.meta.url);
const script = new URL('scripts/spec-diff.mjs', root).pathname;
const current = new URL('spec/openapi.yaml', root).pathname;
const original = readFileSync(current, 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'jsj-spec-diff-'));
let written = 0;

function specAfter(change: (spec: Node) => void): string {
  const spec = parse(original) as Node;
  change(spec);
  const file = join(dir, `${(written += 1)}.yaml`);
  writeFileSync(file, stringify(spec));
  return file;
}

function titleAfter(change: (spec: Node) => void): string {
  return execFileSync('node', [script, '--title', current, specAfter(change)], { encoding: 'utf8' }).trim();
}

function bodyAfter(change: (spec: Node) => void): string {
  return execFileSync('node', [script, current, specAfter(change)], { encoding: 'utf8' }).trim();
}

function parameter(spec: Node, path: string, method: string, name: string): Node {
  const parameters = spec.paths[path][method].parameters as Node[];
  const found = parameters.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no inline parameter ${name} on ${method} ${path}`);
  return found;
}

test('a spec with nothing but prose changed releases nothing', () => {
  assert.equal(
    titleAfter(() => {}),
    'chore: sync openapi.yaml, prose only'
  );
  assert.equal(
    titleAfter((spec) => {
      spec.paths['/folders'].get.description = 'Reworded.';
      spec.components.schemas.FormCreateInput.description = 'Reworded too.';
    }),
    'chore: sync openapi.yaml, prose only'
  );
});

test('a body the CLI sends as given changing releases nothing: the API judges bodies', () => {
  assert.equal(
    titleAfter((spec) => {
      spec.components.schemas.TextFieldInput.properties.future_option = { type: 'boolean' };
    }),
    'chore: sync openapi.yaml, nothing the CLI checks or offers changed'
  );
});

test('an operation the CLI does not call changing releases nothing', () => {
  assert.equal(
    titleAfter((spec) => {
      delete spec.paths['/contacts'];
    }),
    'chore: sync openapi.yaml, nothing the CLI checks or offers changed'
  );
});

test('a list of values a flag offers changing is a feat, named by what reads it', () => {
  assert.equal(
    titleAfter((spec) => {
      spec.components.schemas.FormCreateInput.properties.scene.enum.push('webinar');
    }),
    'feat: follow openapi.yaml changes to createForm scene'
  );
});

test('a document a parameter carries changing is a feat, and a list a flag reads out of it is named', () => {
  const widened = (spec: Node) => spec.components.schemas.ScopeCondition.properties.operator.enum.push('match');
  assert.match(titleAfter(widened), /^feat: follow openapi\.yaml changes to /);
  assert.match(bodyAfter(widened), /`listEntries filters\[\]\.operator` \(\+match\)/);
});

test('the parameters of an operation the CLI calls changing is a feat, and so is its removal', () => {
  assert.equal(
    titleAfter((spec) => {
      parameter(spec, '/folders', 'get', 'limit').schema = { type: 'string' };
    }),
    'feat: follow openapi.yaml changes to listFolders'
  );
  assert.equal(
    titleAfter((spec) => {
      delete spec.paths['/sms/audit_statuses'];
    }),
    'feat: follow openapi.yaml changes to listSmsAuditStatuses'
  );
});
