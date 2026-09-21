import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runCli } from './cli.js';
import { COMMANDS } from './commands.js';

// Help is rendered from the command table, so every command in it is covered
// by walking the table rather than by a list kept in step by hand.
for (const command of COMMANDS) {
  test(`${command.path.join(' ')} --help describes its arguments and flags`, async () => {
    const result = await runCli([...command.path, '--help']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, new RegExp(`Usage: jinshuju ${command.path.join(' ')}`));
    assert.match(result.stdout, /Flags:/);
    for (const argument of command.args ?? []) {
      assert.match(result.stdout, new RegExp(argument.name), `<${argument.name}> is missing from the help`);
    }
    for (const option of command.options ?? []) {
      assert.ok(result.stdout.includes(option.name), `${option.name} is missing from the help`);
    }
  });
}

// The root help lists resources, not every verb: one level, as the design says.
test('root help lists the resources', async () => {
  const result = await runCli([]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage: jinshuju <resource> <verb>/);
  for (const resource of ['auth', 'form', 'table', 'view', 'entry', 'config']) {
    assert.match(result.stdout, new RegExp(`\\n  ${resource}\\s`), `${resource} is missing from the root help`);
  }
});

test('a resource lists its own verbs', async () => {
  const result = await runCli(['entry', '--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /entry list/);
  assert.match(result.stdout, /entry get/);
});

for (const args of [['auth', 'status', '--help'], ['config', 'get', '--help']]) {
  test(`${args.join(' ')} still has help`, async () => {
    const result = await runCli(args);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Usage:/);
  });
}

test('package bin points to executable wrapper, not library module', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.bin.jinshuju, './dist/cli-bin.js');
  assert.equal(pkg.bin.jsj, './dist/cli-bin.js');
});
