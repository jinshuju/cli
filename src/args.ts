import { readFileSync } from 'node:fs';

import type { Command } from './commands/index.js';
import { GLOBAL_OPTIONS, LOCAL_OPTIONS, UsageError, optionKey, readJsonInput, type OptionSpec } from './options.js';

/**
 * The command line, taken apart. Nothing here knows what a command does: it
 * knows which words name one, which flags take a value, and how a value is
 * read into the type its option declares.
 */

type RawArgs = { words: string[]; flags: Record<string, unknown> };

/**
 * The words that name the command: enough to find it, and no more.
 *
 * A flag may come first — `jinshuju --config local.json form list` is what a
 * shell alias expands to, and what anyone arriving from `git -C` or
 * `kubectl --context` writes — so a flag this CLI knows without a command is
 * stepped over, along with its value. Stopping at it instead reported "Unknown
 * command: jinshuju form list" while offering that very command as a
 * suggestion.
 *
 * An unknown flag still ends the scan. Only a command declares those, so by the
 * time one appears the command has been named already.
 */
export function leadingWords(argv: readonly string[]): string[] {
  const known = new Map<string, OptionSpec>();
  for (const spec of [...GLOBAL_OPTIONS, ...LOCAL_OPTIONS]) {
    known.set(spec.name, spec);
    if (spec.short) known.set(spec.short, spec);
  }

  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('-') || token === '-') {
      words.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const spec = known.get(equals === -1 ? token : token.slice(0, equals));
    if (!spec) break;
    if (equals === -1 && spec.type !== 'boolean') index += 1;
  }
  return words;
}

/**
 * Splits the command line, knowing which flags take a value.
 *
 * Guessing from the shape of the next token gets two things wrong that a
 * caller has every right to write: `--json -`, where the value is the very
 * character that looks like a flag, and `--yes 12`, where a boolean must not
 * swallow the argument behind it. Both are decided by the option's own type,
 * so the specs are passed in rather than inferred.
 */
export function splitArgs(argv: readonly string[], specs: readonly OptionSpec[] = []): RawArgs {
  const takesValue = new Map<string, boolean>();
  for (const spec of specs) {
    takesValue.set(spec.name, spec.type !== 'boolean');
    if (spec.short) takesValue.set(spec.short, spec.type !== 'boolean');
  }

  const words: string[] = [];
  const flags: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--') {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      words.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const next = argv[index + 1];
    // An unknown flag is assumed to take a value, so it reaches bindOptions
    // with whatever followed it and is refused by name rather than by shape.
    const wanted = takesValue.get(flag) ?? true;
    const consumable = wanted && next !== undefined && (next === '-' || !next.startsWith('-'));
    const value = inline ?? (consumable ? ((index += 1), next) : true);
    const existing = flags[flag];
    flags[flag] = existing === undefined ? value : ([] as unknown[]).concat(existing as never, value as never);
  }
  return { words, flags };
}

/**
 * Checks the flags against what this command declares. A flag belonging to
 * another command is an error rather than something quietly ignored: that is
 * how a caller learns it asked for something that was never going to happen.
 */
export function bindOptions(
  specs: readonly OptionSpec[],
  flags: Record<string, unknown>,
  label: string,
  stdin: () => string
): Record<string, unknown> {
  const byFlag = new Map<string, OptionSpec>();
  for (const spec of specs) {
    byFlag.set(spec.name, spec);
    if (spec.short) byFlag.set(spec.short, spec);
  }

  const bound: Record<string, unknown> = {};
  for (const [flag, value] of Object.entries(flags)) {
    const spec = byFlag.get(flag);
    if (!spec) throw new UsageError(`${label} does not take ${flag}. Run it with --help to see what it does take.`);
    bound[optionKey(spec)] = coerce(spec, value, stdin);
  }
  return bound;
}

function coerce(spec: OptionSpec, value: unknown, stdin: () => string): unknown {
  if (spec.repeatable) return ([] as unknown[]).concat(value as never).map((item) => coerceOne(spec, item, stdin));
  if (Array.isArray(value)) throw new UsageError(`${spec.name} takes a single value, but was given more than once`);
  return coerceOne(spec, value, stdin);
}

function coerceOne(spec: OptionSpec, value: unknown, stdin: () => string): unknown {
  if (spec.type === 'boolean') {
    if (value === true || value === 'true') return true;
    if (value === 'false') return false;
    throw new UsageError(`${spec.name} is a flag and takes no value`);
  }
  if (value === true) throw new UsageError(`${spec.name} needs a value`);
  const text = String(value);
  if (spec.choices && !spec.choices.includes(text)) {
    throw new UsageError(`${spec.name} must be one of ${spec.choices.join(', ')}, got ${JSON.stringify(text)}`);
  }
  if (spec.type === 'integer') {
    if (!/^\d+$/.test(text)) throw new UsageError(`${spec.name} must be a whole number, got ${JSON.stringify(text)}`);
    return Number.parseInt(text, 10);
  }
  if (spec.type === 'list')
    return text
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  if (spec.type === 'json') return readJsonInput(text, stdin);
  return text;
}

/**
 * A stray word that looks like a token, on a command whose parent is a flag, is
 * almost always `field list <token>` written as `form get <token>` reads. Saying
 * only that the argument is not taken leaves the caller to find that out.
 */
function containerHint(command: Command, extra: string): string {
  const takesContainer = (command.options ?? []).some((option) => option.name === '--form');
  if (!takesContainer || !/^[A-Za-z0-9]{6}$/.test(extra)) return '';
  return `. Did you mean --form ${extra}? (a table: --table ${extra})`;
}

export function bindArgs(command: Command, words: readonly string[]): { args: Record<string, string>; rest: string[] } {
  const positionals = words.slice(command.path.length);
  const specs = command.args ?? [];
  const args: Record<string, string> = {};
  let rest: string[] = [];
  specs.forEach((arg, index) => {
    if (arg.variadic) {
      rest = positionals.slice(index);
      if (arg.required && rest.length === 0) {
        throw new UsageError(`jinshuju ${command.path.join(' ')} needs <${arg.name}>: ${arg.description}`);
      }
      return;
    }
    const value = positionals[index];
    if (value === undefined) {
      if (arg.required)
        throw new UsageError(`jinshuju ${command.path.join(' ')} needs <${arg.name}>: ${arg.description}`);
      return;
    }
    args[arg.name] = value;
  });
  if (!specs.some((arg) => arg.variadic)) {
    const extra = positionals.slice(specs.length);
    if (extra.length > 0) {
      throw new UsageError(
        `jinshuju ${command.path.join(' ')} takes no argument ${JSON.stringify(extra[0])}` +
          containerHint(command, extra[0] as string)
      );
    }
  }
  return { args, rest };
}

export function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    throw new UsageError('could not read JSON from stdin');
  }
}
