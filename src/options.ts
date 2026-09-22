import { readFileSync } from 'node:fs';

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

export const OUTPUT_FORMATS = ['text', 'json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Accepted by every command. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { name: '--output', type: 'string', choices: OUTPUT_FORMATS, placeholder: '<format>', description: 'Output format: text, json' },
  { name: '--config', type: 'string', placeholder: '<path>', description: 'Config file path' },
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
  { name: '--api-key', type: 'string', placeholder: '<key>', description: 'Override API key' },
  { name: '--api-secret', type: 'string', placeholder: '<secret>', description: 'Override API secret' },
  { name: '--host', type: 'string', placeholder: '<url>', description: 'API host' },
  { name: '--auth-host', type: 'string', placeholder: '<url>', description: 'OAuth host' },
  { name: '--client-id', type: 'string', placeholder: '<id>', description: 'OAuth public client id' },
  { name: '--scopes', type: 'string', placeholder: '<scopes>', description: 'Space-separated OAuth scopes' },
  { name: '--no-open', type: 'boolean', description: 'Print the login URL instead of opening a browser' },
  { name: '--verify', type: 'boolean', description: 'Verify the credentials with a lightweight call' },
  { name: '--show-secret', type: 'boolean', description: 'Show secrets unmasked' }
];

/** The data container a command acts on. Mutually exclusive; both map to form_token. */
export const CONTAINER_OPTIONS: readonly OptionSpec[] = [
  { name: '--form', type: 'string', placeholder: '<token>', description: 'Form token, six letters and digits, e.g. Kp7mQ2' },
  { name: '--table', type: 'string', placeholder: '<token>', description: 'Table token, six letters and digits, e.g. Vn4xR8' }
];

/**
 * The same container, repeatable, for the reads that answer about several at
 * once. Still one kind per call: `--form` and `--table` stay mutually exclusive.
 */
export const CONTAINER_LIST_OPTIONS: readonly OptionSpec[] = [
  { name: '--form', type: 'string', repeatable: true, placeholder: '<token>', description: 'Form token, repeatable, e.g. Kp7mQ2' },
  { name: '--table', type: 'string', repeatable: true, placeholder: '<token>', description: 'Table token, repeatable, e.g. Vn4xR8' }
];

export const FILTER_OPTION: OptionSpec = {
  name: '--filter',
  type: 'string',
  repeatable: true,
  placeholder: "'<field> <op> [value]'",
  description:
    "Filter condition, repeatable, AND-combined. e.g. 'field_3 gte 80', 'created_at within_last 30d', 'field_4 between 1,10'"
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
  name: '--limit', type: 'integer', placeholder: '<n>', description: 'Rows per page, up to the listing default'
};

export const PAGINATION_OPTIONS: readonly OptionSpec[] = [
  LIMIT_OPTION,
  { name: '--next', type: 'string', placeholder: '<cursor>', description: 'Cursor from the previous response, passed back verbatim' },
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

export class UsageError extends Error {}

/** `--api-key` reads back as `api_key`. */
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

  if (NO_VALUE_OPERATORS.has(operator)) {
    if (raw) throw new UsageError(`--filter operator '${operator}' takes no value, got ${JSON.stringify(raw)}`);
    return { field, operator };
  }
  if (!raw) throw new UsageError(`--filter operator '${operator}' needs a value`);

  if (PAIR_OPERATORS.has(operator)) {
    const parts = splitList(raw);
    if (parts.length !== 2) {
      throw new UsageError(`--filter operator '${operator}' needs two values separated by a comma, got ${JSON.stringify(raw)}`);
    }
    return { field, operator, value: parts };
  }
  if (LIST_OPERATORS.has(operator)) return { field, operator, value: splitList(raw) };
  if (operator === 'within_last') return { field, operator, value: parseRelativeWindow(raw) };

  return { field, operator, value: raw };
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

/** A comma-separated list, with backslash-escaped commas kept as text. */
function splitList(raw: string): string[] {
  return raw
    .split(/(?<!\\),/)
    .map((part) => part.replace(/\\,/g, ',').trim())
    .filter((part) => part.length > 0);
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

/** The repeatable form of the above, for a read that answers about several. */
export function resolveContainers(options: Record<string, unknown>, max: number): Containers {
  const forms = (options.form as string[] | undefined) ?? [];
  const tables = (options.table as string[] | undefined) ?? [];
  if (forms.length > 0 && tables.length > 0) throw new UsageError('--form and --table are mutually exclusive');

  const tokens = forms.length > 0 ? forms : tables;
  if (tokens.length === 0) throw new UsageError('one of --form <token> or --table <token> is required');
  if (tokens.length > max) {
    throw new UsageError(`at most ${max} containers can be asked about in one call, got ${tokens.length}`);
  }
  return { tokens, kind: forms.length > 0 ? 'form' : 'table' };
}
