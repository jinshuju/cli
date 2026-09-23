import { COMMANDS, RESOURCES, findCommand, type Command } from './commands.js';
import { GLOBAL_OPTIONS, optionKey, type OptionSpec } from './options.js';

/**
 * Help is rendered from the command table, so a command cannot be reachable
 * without appearing here, and a flag cannot be accepted without being
 * described. The root help lists one line per resource, then the global
 * options.
 */

export function rootHelp(commands: readonly Command[] = COMMANDS): string {
  const present = new Set(commands.map((command) => command.path[0]));
  const resources = RESOURCES.filter((resource) => present.has(resource.name) || resource.name === 'auth' || resource.name === 'config');
  const width = Math.max(...resources.map((resource) => resource.name.length)) + 4;

  return [
    'Usage: jinshuju <resource> <verb> [args] [flags]',
    '',
    'Commands:',
    ...resources.map((resource) => `  ${resource.name.padEnd(width)}${resource.summary}`),
    '',
    'Global Options:',
    ...GLOBAL_OPTIONS.map((option) => `  ${flagLabel(option).padEnd(width + 12)}${option.description}`),
    '',
    'Run `jinshuju <resource> --help` to see its verbs.',
    '`jsj` is the same command, for typing less.',
    '',
    'Exit codes: 0 ok, 1 unknown command, 2 the request was wrong, 3 rate limited',
    '(wait and retry; --output json carries retry_after).',
    ''
  ].join('\n');
}

/** Every verb of one resource, for `jinshuju form --help`. */
export function resourceHelp(resource: string, commands: readonly Command[] = COMMANDS): string {
  const owned = commands.filter((command) => command.path[0] === resource);
  if (owned.length === 0) return rootHelp(commands);
  const width = Math.max(...owned.map((command) => command.path.join(' ').length)) + 4;

  const note = RESOURCES.find((entry) => entry.name === resource)?.note;

  return [
    `Usage: jinshuju ${resource} <verb> [args] [flags]`,
    '',
    'Commands:',
    ...owned.map((command) => `  ${command.path.join(' ').padEnd(width)}${command.summary}`),
    ...(note ? ['', note] : []),
    '',
    `Run \`jinshuju ${resource} <verb> --help\` for one of them.`,
    ''
  ].join('\n');
}

export function commandHelp(command: Command): string {
  const usage = [
    'Usage: jinshuju',
    ...command.path,
    ...(command.args ?? []).map((arg) => {
      const name = arg.required ? `<${arg.name}>` : `[${arg.name}]`;
      return arg.variadic ? `${name}...` : name;
    }),
    '[flags]'
  ].join(' ');

  const parts = [usage, '', command.description ?? command.summary];

  if (command.args?.length) {
    const width = Math.max(...command.args.map((arg) => arg.name.length)) + 4;
    parts.push('', 'Arguments:', ...command.args.map((arg) => `  ${arg.name.padEnd(width)}${arg.description}`));
  }

  const options = [...(command.options ?? []), ...GLOBAL_OPTIONS];
  const width = Math.max(...options.map((option) => flagLabel(option).length)) + 4;
  parts.push('', 'Flags:', ...options.map((option) => `  ${flagLabel(option).padEnd(width)}${option.description}`));

  if (command.payload?.length) parts.push('', 'Payload:', ...command.payload.map((line) => `  ${line}`));

  if (command.examples?.length) parts.push('', 'Examples:', ...command.examples.map((example) => `  ${example}`));

  return `${parts.join('\n')}\n`;
}

/** What the caller typed that matched nothing, and the nearest things that do. */
export function unknownCommandHelp(words: readonly string[], commands: readonly Command[] = COMMANDS): string {
  const typed = words.join(' ');
  const resource = words[0];
  const siblings = commands.filter((command) => command.path[0] === resource).slice(0, 10);
  return [
    `Unknown command: jinshuju ${typed}`,
    ...(siblings.length > 0
      ? ['', 'Did you mean:', ...siblings.map((command) => `  jinshuju ${command.path.join(' ')}`)]
      : []),
    '',
    'Run `jinshuju --help` for the full list.',
    ''
  ].join('\n');
}

/** Help for whatever the words point at: a command, a resource, or the root. */
export function helpFor(words: readonly string[], commands: readonly Command[] = COMMANDS): string {
  if (words.length === 0) return rootHelp(commands);
  const command = findCommand(words, commands);
  if (command) return commandHelp(command);
  const resource = words[0] as string;
  if (commands.some((candidate) => candidate.path[0] === resource)) return resourceHelp(resource, commands);
  return rootHelp(commands);
}

function flagLabel(option: OptionSpec): string {
  const flags = option.short ? `${option.short}, ${option.name}` : option.name;
  if (option.type === 'boolean') return flags;
  return `${flags} ${option.placeholder ?? `<${optionKey(option)}>`}`;
}
