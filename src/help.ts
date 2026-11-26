import { COMMANDS, RESOURCES, findCommand, type Command } from './commands/index.js';
import { EXIT_CODES } from './errors.js';
import { GLOBAL_OPTIONS, optionKey, type OptionSpec } from './options.js';
import { PLAIN, type Style } from './style.js';
import { VERSION } from './version.js';

/**
 * Help is rendered from the command table, so a command cannot be reachable
 * without appearing here, and a flag cannot be accepted without being
 * described. The root help lists one line per resource, then the global
 * options.
 *
 * Every help opens with the version, piped or not: help is read by a person,
 * and which version it describes is the first thing worth knowing about it.
 */

/** `jinshuju v0.5.0`, for the top of a help and of an error at a terminal. */
export function versionLine(style: Style = PLAIN): string {
  return `${style.heading('jinshuju')} ${style.dim(`v${VERSION}`)}`;
}

export function rootHelp(commands: readonly Command[] = COMMANDS, style: Style = PLAIN): string {
  const present = new Set(commands.map((command) => command.path[0]));
  const resources = RESOURCES.filter(
    (resource) => present.has(resource.name) || resource.name === 'auth' || resource.name === 'config'
  );
  const width = Math.max(...resources.map((resource) => resource.name.length)) + 4;

  return [
    versionLine(style),
    '',
    `${style.heading('Usage:')} jinshuju <resource> <verb> [args] [flags]`,
    '',
    style.heading('Commands:'),
    ...resources.map((resource) => `  ${resource.name.padEnd(width)}${resource.summary}`),
    '',
    style.heading('Global Options:'),
    ...GLOBAL_OPTIONS.map((option) => `  ${flagLabel(option).padEnd(width + 12)}${option.description}`),
    '',
    'Run `jinshuju <resource> --help` to see its verbs.',
    '`jsj` is the same command, for typing less.',
    '',
    'Exit codes: 0 ok, ' +
      `${EXIT_CODES.unexpected} unexpected, ${EXIT_CODES.usage} usage, ${EXIT_CODES.auth} authentication, ` +
      `${EXIT_CODES.not_found} not found, ${EXIT_CODES.refused} refused by the API, ${EXIT_CODES.server} server failure, ` +
      `${EXIT_CODES.transport} no connection or timed out, ${EXIT_CODES.rate_limited} rate limited (wait and retry; ` +
      `--output json carries retry_after), ${EXIT_CODES.pending} a device login still waiting for approval.`,
    ''
  ].join('\n');
}

/** Every verb of one resource, for `jinshuju form --help`. */
export function resourceHelp(resource: string, commands: readonly Command[] = COMMANDS, style: Style = PLAIN): string {
  const owned = commands.filter((command) => command.path[0] === resource);
  if (owned.length === 0) return rootHelp(commands, style);
  const width = Math.max(...owned.map((command) => command.path.join(' ').length)) + 4;
  const note = RESOURCES.find((entry) => entry.name === resource)?.note;

  return [
    versionLine(style),
    '',
    `${style.heading('Usage:')} jinshuju ${resource} <verb> [args] [flags]`,
    '',
    style.heading('Commands:'),
    ...owned.map((command) => `  ${command.path.join(' ').padEnd(width)}${command.summary}`),
    ...(note ? ['', note] : []),
    '',
    `Run \`jinshuju ${resource} <verb> --help\` for one of them.`,
    ''
  ].join('\n');
}

export function commandHelp(command: Command, style: Style = PLAIN): string {
  const usage = [
    `${style.heading('Usage:')} jinshuju`,
    ...command.path,
    ...(command.args ?? []).map((arg) => {
      const name = arg.required ? `<${arg.name}>` : `[${arg.name}]`;
      return arg.variadic ? `${name}...` : name;
    }),
    '[flags]'
  ].join(' ');

  const parts = [versionLine(style), '', usage, '', command.description ?? command.summary];

  if (command.args?.length) {
    const width = Math.max(...command.args.map((arg) => arg.name.length)) + 4;
    parts.push(
      '',
      style.heading('Arguments:'),
      ...command.args.map((arg) => `  ${arg.name.padEnd(width)}${arg.description}`)
    );
  }

  // One width across both lists, so the descriptions line up down the page.
  const own = command.options ?? [];
  const width = Math.max(...[...own, ...GLOBAL_OPTIONS].map((option) => flagLabel(option).length)) + 4;
  const describe = (option: OptionSpec) => `  ${flagLabel(option).padEnd(width)}${option.description}`;
  if (own.length > 0) parts.push('', style.heading('Flags:'), ...own.map(describe));
  parts.push('', style.heading('Global Options:'), ...GLOBAL_OPTIONS.map(describe));

  if (command.payload?.length) parts.push('', style.heading('Payload:'), ...command.payload.map((line) => `  ${line}`));

  if (command.examples?.length) {
    parts.push('', style.heading('Examples:'), ...command.examples.map((example) => `  ${example}`));
  }

  return `${parts.join('\n')}\n`;
}

/**
 * How far a command is from what was typed after the resource: the words it
 * shares with it count most, and the edits that turn one word into the other
 * break ties. `artifact get <id>` is nearest `artifact share get`, `field rmove`
 * nearest `field remove`.
 */
function distanceTo(command: Command, words: readonly string[]): number {
  const wanted = command.path.slice(1);
  const typed = words.slice(1, 1 + Math.max(wanted.length, 1));
  const shared = wanted.filter((word) => typed.includes(word)).length;
  const edits = wanted.reduce((sum, word, index) => sum + editDistance(word, typed[index] ?? ''), 0);
  return edits - 100 * shared;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** What the caller typed that matched nothing, and the nearest things that do. */
export function unknownCommandHelp(
  words: readonly string[],
  commands: readonly Command[] = COMMANDS,
  style: Style = PLAIN
): string {
  const typed = words.join(' ');
  const resource = words[0];
  // Nearest first: a resource has more commands than the list shows, and the one
  // meant used to be cut off whenever it was declared late.
  const siblings = commands
    .filter((command) => command.path[0] === resource)
    .map((command, order) => ({ command, order, distance: distanceTo(command, words) }))
    .sort((a, b) => a.distance - b.distance || a.order - b.order)
    .slice(0, 10)
    .map(({ command }) => command);
  return [
    `Unknown command: jinshuju ${typed}`,
    ...(siblings.length > 0
      ? ['', style.heading('Did you mean:'), ...siblings.map((command) => `  jinshuju ${command.path.join(' ')}`)]
      : []),
    '',
    'Run `jinshuju --help` for the full list.',
    ''
  ].join('\n');
}

/** Help for whatever the words point at: a command, a resource, or the root. */
export function helpFor(
  words: readonly string[],
  commands: readonly Command[] = COMMANDS,
  style: Style = PLAIN
): string {
  if (words.length === 0) return rootHelp(commands, style);
  const command = findCommand(words, commands);
  if (command) return commandHelp(command, style);
  const resource = words[0] as string;
  if (commands.some((candidate) => candidate.path[0] === resource)) return resourceHelp(resource, commands, style);
  return rootHelp(commands, style);
}

function flagLabel(option: OptionSpec): string {
  const flags = option.short ? `${option.short}, ${option.name}` : option.name;
  if (option.type === 'boolean') return flags;
  return `${flags} ${option.placeholder ?? `<${optionKey(option)}>`}`;
}
