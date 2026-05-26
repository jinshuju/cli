import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runCli } from './cli.js';

const helpCommands = [
  [],
  ['auth', 'status', '--help'],
  ['config', 'get', '--help'],
  ['config', 'set', '--help'],
  ['config', 'unset', '--help'],
  ['form', 'list', '--help'],
  ['form', 'get', '--help'],
  ['form', 'create', '--help'],
  ['form', 'entry', 'list', '--help'],
  ['form', 'entry', 'get', '--help'],
  ['form', 'entry', 'create', '--help'],
  ['form', 'view', 'list', '--help'],
  ['form', 'view', 'get', '--help'],
  ['form', 'view', 'entry', 'list', '--help']
];

for (const args of helpCommands) {
  test(`${args.join(' ') || 'root'} help includes usage/options/examples`, async () => {
    const result = await runCli(args);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /Options:/);
    assert.match(result.stdout, /Examples:|Commands:/);
  });
}

test('package bin points to executable wrapper, not library module', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.bin.jinshuju, './dist/cli-bin.js');
  assert.equal(pkg.bin.jsj, './dist/cli-bin.js');
});
