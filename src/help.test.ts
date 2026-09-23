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

/**
 * `Usage:` alone is what the root listing says too, so asserting it let the
 * local commands quietly lose their help: every one of them answered with the
 * root listing and the test stayed green. Each is now checked for its own
 * usage line and for a flag or argument only it has.
 */
const LOCAL_HELP: [string[], RegExp][] = [
  [['auth', 'login'], /--no-open/],
  [['auth', 'status'], /--verify/],
  [['auth', 'refresh'], /--auth-host/],
  [['auth', 'logout'], /--client-id/],
  [['config', 'get'], /--show-secret/],
  [['config', 'set'], /<key> <value>/],
  [['config', 'unset'], /access_token/]
];

for (const [path, own] of LOCAL_HELP) {
  test(`${path.join(' ')} documents itself, not the root listing`, async () => {
    const result = await runCli([...path, '--help']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, new RegExp(`Usage: jinshuju ${path.join(' ')}`));
    assert.match(result.stdout, own);
    assert.doesNotMatch(result.stdout, /Run `jinshuju <resource> --help`/);
  });
}

test('package bin points to executable wrapper, not library module', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.bin.jinshuju, './dist/cli-bin.js');
  assert.equal(pkg.bin.jsj, './dist/cli-bin.js');
});

// A flag named `<json>` says nothing about what goes in it. Every command that
// declares a payload has to show it, and show the way to the field types — the
// part of the shape no example can carry.
for (const command of COMMANDS.filter((entry) => entry.payload?.length)) {
  test(`${command.path.join(' ')} --help shows the payload it expects`, async () => {
    const result = await runCli([...command.path, '--help']);

    assert.match(result.stdout, /Payload:/);
    assert.match(result.stdout, /jinshuju field types/);
  });
}

test('a command that takes no payload shows no payload section', async () => {
  const result = await runCli(['form', 'list', '--help']);

  assert.doesNotMatch(result.stdout, /Payload:/);
});

// A payload example is prose as far as the compiler is concerned: nothing runs
// it, so a broken one ships. The example shipped with `label` on a choice, which
// the API refuses — the key is `name`. Parsing it back is the cheapest guard
// that it is at least still a well-formed payload.
for (const command of COMMANDS.filter((entry) => entry.payload?.length)) {
  test(`${command.path.join(' ')} shows a payload example that is valid JSON`, () => {
    const json = command.payload!.slice(0, command.payload!.indexOf('')).join('\n');
    const parsed = JSON.parse(json) as Record<string, unknown>;

    for (const field of (parsed.fields as Record<string, unknown>[] | undefined) ?? [parsed]) {
      for (const choice of (field.choices as Record<string, unknown>[] | undefined) ?? []) {
        assert.ok('name' in choice, `a choice is keyed ${JSON.stringify(Object.keys(choice))}, but the API reads "name"`);
      }
    }
  });
}
