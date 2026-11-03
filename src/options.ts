import { readFileSync } from 'node:fs';

import { UsageError } from './errors.js';
import { choices } from './spec.js';

/**
 * The shared option grammar, written once here because every resource uses it:
 * container, filter, sort, pagination, JSON input and output format.
 */

export type OptionType = 'string' | 'integer' | 'boolean' | 'json' | 'list';

export interface OptionSpec {
  /** Long flag with dashes, e.g. `--filter`. */
  readonly name: string;
  readonly short?: string;
  readonly type: OptionType;
  /** May be given more than once; values collect into a list. */
  readonly repeatable?: boolean;
  /** Placeholder shown in help, e.g. `<field> <op> [value]`. */
  readonly placeholder?: string;
  readonly choices?: readonly string[];
  readonly description: string;
}

export const OUTPUT_FORMATS = ['text', 'json', 'jsonl'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Accepted by every command. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--output',
    type: 'string',
    choices: OUTPUT_FORMATS,
    placeholder: '<format>',
    description: 'Output format: text, json, or jsonl (one JSON object per line; a listing streams its rows)'
  },
  { name: '--config', type: 'string', placeholder: '<path>', description: 'Config file path' },
  {
    name: '--as-is',
    type: 'boolean',
    description:
      'Send a payload as it is, skipping the check against the openapi.yaml this CLI shipped with; for when the API has since learned what it refuses'
  },
  { name: '--help', short: '-h', type: 'boolean', description: 'Show help' },
  // -V rather than -v: nearly every CLI reads -v as verbose, and a flag that
  // prints a version where the reader expected more output is a small betrayal.
  // -v is left unclaimed, so it is free for --verbose if that ever exists.
  { name: '--version', short: '-V', type: 'boolean', description: 'Show version' }
];

/**
 * What the local commands — auth and config, the ones that never reach the API —
 * accept on top of the global options. They live here so the command table can
 * describe them: help is rendered from that table, and a flag nobody can find
 * in it is a flag nobody knows about.
 */
export const LOCAL_OPTIONS: readonly OptionSpec[] = [
  { name: '--access-token', type: 'string', placeholder: '<token>', description: 'Log in with an access token' },
  { name: '--host', type: 'string', placeholder: '<url>', description: 'API host' },
  { name: '--auth-host', type: 'string', placeholder: '<url>', description: 'OAuth host' },
  { name: '--client-id', type: 'string', placeholder: '<id>', description: 'OAuth public client id' },
  { name: '--scopes', type: 'string', placeholder: '<scopes>', description: 'Space-separated OAuth scopes' },
  { name: '--no-open', type: 'boolean', description: 'Print the login URL instead of opening a browser' },
  {
    name: '--device',
    type: 'boolean',
    description: 'Log in by entering a short code on any other device; no browser or open port needed here'
  },
  {
    name: '--no-wait',
    type: 'boolean',
    description: 'Start a device login, print its link and code, and exit; finish it with --resume'
  },
  { name: '--resume', type: 'boolean', description: 'Finish the device login --no-wait started' },
  {
    name: '--timeout',
    type: 'string',
    placeholder: '<seconds>',
    description: 'How long --resume waits for the approval before exiting 9 (default 60)'
  },
  { name: '--verify', type: 'boolean', description: 'Verify the credentials with a lightweight call' }
];

/** The data container a command acts on. Mutually exclusive; both map to form_token. */
export const CONTAINER_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--form',
    type: 'string',
    placeholder: '<token>',
    description: 'Form token, six letters and digits, e.g. Kp7mQ2'
  },
  {
    name: '--table',
    type: 'string',
    placeholder: '<token>',
    description: 'Table token, six letters and digits, e.g. Vn4xR8'
  }
];

/**
 * The same container, repeatable, for the reads that answer about several at
 * once. Still one kind per call: `--form` and `--table` stay mutually exclusive.
 */
export const CONTAINER_LIST_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--form',
    type: 'string',
    repeatable: true,
    placeholder: '<token>',
    description: 'Form token, repeatable, e.g. Kp7mQ2'
  },
  {
    name: '--table',
    type: 'string',
    repeatable: true,
    placeholder: '<token>',
    description: 'Table token, repeatable, e.g. Vn4xR8'
  }
];

/**
 * The operators a condition takes, off the spec's own ScopeCondition. The
 * list this replaced was written here, and had drifted: it offered `match`,
 * which the spec does not list.
 */
const FILTER_OPERATORS = choices('listEntries', 'filters[].operator');

/**
 * What a caller writes for an operator the API spells otherwise. Sixteen
 * users in three days wrote `=`, `in` or `not_empty`, and the server answered
 * each with the whole list; the one they meant is named instead.
 */
const OPERATOR_ALIASES: Readonly<Record<string, string>> = {
  '=': 'eq',
  '==': 'eq',
  '===': 'eq',
  is: 'eq',
  equals: 'eq',
  '!=': 'ne',
  '!==': 'ne',
  '<>': 'ne',
  neq: 'ne',
  not: 'ne',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  in: 'any_in',
  not_in: 'none_in',
  nin: 'none_in',
  not_empty: 'not_null',
  not_blank: 'not_null',
  present: 'not_null',
  exists: 'not_null',
  is_not_null: 'not_null',
  empty: 'null',
  blank: 'null',
  is_null: 'null',
  missing: 'null',
  contains: 'like',
  includes: 'like',
  match: 'like',
  matches: 'like',
  not_contains: 'not_like',
  excludes: 'not_like',
  starts_with: 'start',
  startswith: 'start',
  begins_with: 'start',
  ends_with: 'end',
  endswith: 'end',
  last: 'within_last',
  within: 'within_last'
};

export const FILTER_OPTION: OptionSpec = {
  name: '--filter',
  type: 'string',
  repeatable: true,
  placeholder: "'<field> <op> [value]'",
  description:
    'Filter condition, one per flag, repeatable, AND-combined. ' +
    (FILTER_OPERATORS ? `Operators: ${FILTER_OPERATORS.join(' ')}. ` : '') +
    "e.g. 'field_3 gte 80', 'created_at within_last 30d', 'field_4 between 1,10'"
};

export const FILTERS_OPTION: OptionSpec = {
  name: '--filters',
  type: 'json',
  placeholder: '<json|@file>',
  description: 'Filter conditions as raw JSON, for conditions --filter cannot express'
};

export const SORT_OPTION: OptionSpec = {
  name: '--sort',
  type: 'string',
  repeatable: true,
  placeholder: '<field>:asc|desc',
  description: 'Sort rule, repeatable'
};

/** Asks for a smaller page; a listing's default is also its cap. */
export const LIMIT_OPTION: OptionSpec = {
  name: '--limit',
  type: 'integer',
  placeholder: '<n>',
  description: 'Rows per page, up to the listing default'
};

export const PAGINATION_OPTIONS: readonly OptionSpec[] = [
  LIMIT_OPTION,
  {
    name: '--next',
    type: 'string',
    placeholder: '<cursor>',
    description: 'Cursor from the previous response, passed back verbatim'
  },
  { name: '--all', type: 'boolean', description: 'Follow the cursor and return every page' }
];

export const JSON_OPTION: OptionSpec = {
  name: '--json',
  type: 'json',
  placeholder: '<json|@file|->',
  description: 'JSON payload: inline, @file, or - to read stdin'
};

export const MINE_OPTION: OptionSpec = {
  name: '--mine',
  type: 'boolean',
  description: 'Switch to what the current user submitted'
};

export { UsageError } from './errors.js';

/** `--auth-host` reads back as `auth_host`. */
export function optionKey(spec: OptionSpec): string {
  return spec.name.replace(/^--/, '').replace(/-/g, '_');
}

// --- filter ----------------------------------------------------------------

export interface FilterCondition {
  readonly field: string;
  readonly operator: string;
  readonly value?: unknown;
}

const NO_VALUE_OPERATORS = new Set(['null', 'not_null']);
const PAIR_OPERATORS = new Set(['between', 'not_between']);
const LIST_OPERATORS = new Set(['any_in', 'none_in']);
const RELATIVE_UNITS: Record<string, string> = { d: 'day', w: 'week', m: 'month' };

/**
 * `field_3 gte 80` into `{field, operator, value}`.
 *
 * Values stay strings. The server converts a condition value by the field's own
 * type — a number field runs it through to_f — so a phone number keeps its
 * digits instead of being guessed into a number here. Only the operators whose
 * value has a shape get one built: a pair, a list, or a relative window.
 */
export function parseFilter(input: string): FilterCondition {
  const match = /^\s*(\S+)\s+(\S+)\s*(.*)$/.exec(input);
  if (!match) {
    throw new UsageError(`--filter must be '<field> <op> [value]', got ${JSON.stringify(input)}`);
  }
  const [, field, operator, rest] = match as unknown as [string, string, string, string];
  const raw = rest.trim();
  checkOperator(operator);
  checkOneCondition(field, operator, raw);

  if (NO_VALUE_OPERATORS.has(operator)) {
    if (raw) throw new UsageError(`--filter operator '${operator}' takes no value, got ${JSON.stringify(raw)}`);
    return { field, operator };
  }
  if (!raw) throw new UsageError(`--filter operator '${operator}' needs a value`);

  if (PAIR_OPERATORS.has(operator)) {
    const parts = splitList(raw);
    if (parts.length !== 2) {
      throw new UsageError(
        `--filter operator '${operator}' needs two values separated by a comma, got ${JSON.stringify(raw)}`
      );
    }
    return { field, operator, value: parts };
  }
  if (LIST_OPERATORS.has(operator)) return { field, operator, value: splitList(raw) };
  if (operator === 'within_last') return { field, operator, value: parseRelativeWindow(raw) };

  return { field, operator, value: unquoted(raw) };
}

/**
 * An operator the spec does not list is refused here, with the one meant
 * when it can be told. The list is the spec's, read as every flag's list
 * is, so an operator the API learns reaches the CLI with the next sync.
 */
function checkOperator(operator: string): void {
  if (!FILTER_OPERATORS || FILTER_OPERATORS.includes(operator)) return;
  const lowered = operator.toLowerCase();
  const meant = FILTER_OPERATORS.includes(lowered) ? lowered : OPERATOR_ALIASES[lowered];
  const instead = meant === undefined ? 'is not one' : `is written '${meant}'`;
  throw new UsageError(`--filter operator '${operator}' ${instead}. Operators: ${FILTER_OPERATORS.join(' ')}`);
}

/**
 * Two conditions in one --filter — `field_15 eq S5mp and field_4 equal 通过`
 * — would go as one, the whole tail being field_15's value, and the server
 * would say the value is not one of its choices. A value may well contain
 * "and"; only an "and" followed by a field and an operator is read as a
 * second condition.
 */
function checkOneCondition(field: string, operator: string, raw: string): void {
  const next = /\s+(?:and|&&)\s+(\S+)\s+(\S+)/i.exec(raw);
  if (!next) return;
  const [, nextField, nextOperator] = next as unknown as [string, string, string];
  const known = FILTER_OPERATORS?.includes(nextOperator) || nextOperator.toLowerCase() in OPERATOR_ALIASES;
  if (!known) return;
  const first = raw.slice(0, next.index).trim();
  throw new UsageError(
    `--filter takes one condition; write the next as its own flag: ` +
      `--filter '${field} ${operator} ${first}' --filter '${nextField} ${nextOperator} …'`
  );
}

/** `30d` into `{unit: 'day', n: 30}`. */
function parseRelativeWindow(raw: string): { unit: string; n: number } {
  const match = /^(\d+)\s*([dwm])$/i.exec(raw);
  if (!match) {
    throw new UsageError(`--filter within_last needs a window like 30d, 4w or 6m, got ${JSON.stringify(raw)}`);
  }
  const n = Number.parseInt(match[1] as string, 10);
  if (n <= 0) throw new UsageError(`--filter within_last needs a positive window, got ${JSON.stringify(raw)}`);
  return { unit: RELATIVE_UNITS[(match[2] as string).toLowerCase()] as string, n };
}

/** A comma-separated list, with backslash-escaped commas kept as text, and each value out of its quotes. */
function splitList(raw: string): string[] {
  return raw
    .split(/(?<!\\),/)
    .map((part) => unquoted(part.replace(/\\,/g, ',').trim()))
    .filter((part) => part.length > 0);
}

/**
 * A value written in quotes — `between "2026-10-31 00:00:00","2026-10-31
 * 23:59:59"`, as a shell user quotes out of habit — went up with the quotes
 * on, and the server said it was not a date range. A pair of matching quotes
 * around the whole value is taken off; a quote inside one is text.
 */
function unquoted(text: string): string {
  const quote = text[0];
  const paired = text.length >= 2 && (quote === '"' || quote === "'") && text.endsWith(quote);
  return paired ? text.slice(1, -1) : text;
}

// --- sort ------------------------------------------------------------------

export interface SortRule {
  readonly field: string;
  readonly order: 'asc' | 'desc';
}

/** `created_at:desc`; the order defaults to asc, as a bare field reads. */
export function parseSort(input: string): SortRule {
  const [field, order = 'asc'] = input.split(':');
  if (!field) throw new UsageError(`--sort must be '<field>:asc|desc', got ${JSON.stringify(input)}`);
  if (order !== 'asc' && order !== 'desc') {
    throw new UsageError(`--sort order must be asc or desc, got ${JSON.stringify(order)}`);
  }
  return { field, order };
}

// --- metrics and dimensions ------------------------------------------------

export interface Metric {
  readonly func: string;
  readonly field: string;
}

export interface Dimension {
  readonly field: string;
  readonly bucket?: string;
}

export const TIME_BUCKETS = ['day', 'week', 'month'] as const;

/**
 * `avg:field_3`. Which functions a field takes is the field's own answer — read
 * `analytics.agg_funcs` off `form get --include-analytics` — so the function is
 * passed through rather than checked against a list kept here, the same way an
 * operator is.
 */
export function parseMetric(input: string): Metric {
  const [func, field] = input.split(':');
  if (!func || !field) throw new UsageError(`--metric must be '<func>:<field>', got ${JSON.stringify(input)}`);
  return { func, field };
}

/** `field_7`, or `created_at:month` for a date. */
export function parseDimension(input: string): Dimension {
  const [field, bucket] = input.split(':');
  if (!field) throw new UsageError(`--by must be '<field>[:${TIME_BUCKETS.join('|')}]', got ${JSON.stringify(input)}`);
  if (bucket === undefined) return { field };
  if (!(TIME_BUCKETS as readonly string[]).includes(bucket)) {
    throw new UsageError(`--by bucket must be ${TIME_BUCKETS.join(', ')}, got ${JSON.stringify(bucket)}`);
  }
  return { field, bucket };
}

// --- json input ------------------------------------------------------------

/** Inline JSON, `@path`, or `-` for stdin. */
export function readJsonInput(raw: string, stdin: () => string): unknown {
  let source = raw;
  if (raw === '-') {
    source = stdin();
  } else if (raw.startsWith('@')) {
    const path = raw.slice(1);
    try {
      source = readFileSync(path, 'utf8');
    } catch (error) {
      throw new UsageError(`could not read ${path}: ${(error as Error).message}`);
    }
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new UsageError(`invalid JSON: ${(error as Error).message}`);
  }
}

// --- container -------------------------------------------------------------

export interface Container {
  readonly token: string;
  readonly kind: 'form' | 'table';
}

/**
 * Both `--form` and `--table` address the same API parameter, so exactly one has
 * to be given: a command that guessed would read the wrong object silently.
 */
export function resolveContainer(options: Record<string, unknown>): Container {
  const form = options.form as string | undefined;
  const table = options.table as string | undefined;
  if (form && table) throw new UsageError('--form and --table are mutually exclusive');
  if (form) return { token: form, kind: 'form' };
  if (table) return { token: table, kind: 'table' };
  throw new UsageError('one of --form <token> or --table <token> is required');
}

export interface Containers {
  readonly tokens: readonly string[];
  readonly kind: 'form' | 'table';
}

/**
 * Every container named, of one kind, possibly none: a search that names no
 * container lets the server choose. Still one kind per call.
 */
export function namedContainers(options: Record<string, unknown>): Containers {
  const forms = (options.form as string[] | undefined) ?? [];
  const tables = (options.table as string[] | undefined) ?? [];
  if (forms.length > 0 && tables.length > 0) throw new UsageError('--form and --table are mutually exclusive');
  return { tokens: forms.length > 0 ? forms : tables, kind: forms.length > 0 ? 'form' : 'table' };
}

/**
 * The repeatable form of resolveContainer, for a read that answers about
 * several. How many it may name is the API's to say: the number is in its
 * prose rather than its schema, and a copy enforced here would go on refusing
 * after the API took more.
 */
export function resolveContainers(options: Record<string, unknown>): Containers {
  const containers = namedContainers(options);
  if (containers.tokens.length === 0) throw new UsageError('one of --form <token> or --table <token> is required');
  return containers;
}
