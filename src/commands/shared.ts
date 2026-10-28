import type { HttpRequest } from '../http.js';
import {
  FILTER_OPTION,
  FILTERS_OPTION,
  UsageError,
  parseFilter,
  parseSort,
  resolveContainer,
  type FilterCondition,
  type OptionSpec,
  type SortRule
} from '../options.js';
import { call, type CallParts, type OperationId } from '../spec.js';
import { isRecord } from '../values.js';
import type { CommandInput, Pagination } from './types.js';

/** What more than one resource's commands build their requests from. */

/**
 * The request for whichever container was named. openapi.yaml has a form's
 * operation and a table's as two, under two paths; the CLI has one command and
 * `--form` or `--table`, so the flag picks the operation and its token fills
 * the path.
 */
export function onContainer(
  input: CommandInput,
  form: OperationId,
  table: OperationId,
  parts: CallParts = {}
): HttpRequest {
  const { token, kind } = resolveContainer(input.options);
  return kind === 'table'
    ? call(table, { ...parts, path: { ...parts.path, table_token: token } })
    : call(form, { ...parts, path: { ...parts.path, form_token: token } });
}

/** The conditions themselves. A read sends them as a query string, a write as a body. */
export function filterConditions(input: CommandInput): unknown {
  const compact = (input.options.filter as string[] | undefined) ?? [];
  const raw = input.options.filters;
  if (raw !== undefined && compact.length > 0) {
    throw new UsageError('--filter and --filters are alternatives, not both');
  }
  if (raw !== undefined) return raw;
  if (compact.length === 0) return undefined;
  const conditions: FilterCondition[] = compact.map(parseFilter);
  return conditions;
}

export function filters(input: CommandInput): string | undefined {
  const conditions = filterConditions(input);
  return conditions === undefined ? undefined : JSON.stringify(conditions);
}

export function sort(input: CommandInput, key: 'api_code' | 'field'): string | undefined {
  const rules = (input.options.sort as string[] | undefined) ?? [];
  if (rules.length === 0) return undefined;
  // The API names a sort key `api_code` for data and `field` for listings; the
  // CLI shows one `--sort <field>:<order>` and translates here.
  return JSON.stringify(rules.map(parseSort).map((rule: SortRule) => ({ [key]: rule.field, order: rule.order })));
}

export function paging(input: CommandInput): { limit?: number; next?: string } {
  return { limit: input.options.limit as number | undefined, next: input.options.next as string | undefined };
}

/** A range of days, Asia/Shanghai; either end can be left open. */
export const DAY_RANGE_OPTIONS: readonly OptionSpec[] = [
  { name: '--from', type: 'string', placeholder: '<YYYY-MM-DD>', description: 'First day, Asia/Shanghai' },
  { name: '--to', type: 'string', placeholder: '<YYYY-MM-DD>', description: 'Last day, inclusive' }
];

export function dayRange(input: CommandInput): { start_date?: string; end_date?: string } {
  return { start_date: input.options.from as string | undefined, end_date: input.options.to as string | undefined };
}

/** The sort rules as the API's own objects, for a body. */
export function sortRules(input: CommandInput): { api_code: string; order: string }[] | undefined {
  const rules = (input.options.sort as string[] | undefined) ?? [];
  if (rules.length === 0) return undefined;
  return rules.map(parseSort).map((rule: SortRule) => ({ api_code: rule.field, order: rule.order }));
}

/**
 * A delete says so out loud. Nothing here prompts — stdin belongs to `--json -`
 * — so the confirmation is a flag, and leaving it out is the safe outcome
 * rather than a question nobody is there to answer.
 */
export function confirmed(input: CommandInput, what: string): void {
  if (!input.options.yes) throw new UsageError(`${what} is permanent; pass --yes to go ahead`);
}

/**
 * Drops the keys an optional flag left undefined. JSON.stringify would drop
 * them on the wire anyway, but a body that carries them reads as though the
 * caller asked for the field to be unset, and shows up that way in --output
 * json and in anything asserting on the request.
 */
export function given<T extends Record<string, unknown>>(body: T): Partial<T> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/**
 * A payload with the flags that were actually given laid over it.
 *
 * The obvious spelling — spread the payload, then assign each flag — writes
 * `undefined` for every flag the caller left out, and that erases whatever the
 * payload said. Someone asking for an exam form through --json got a plain one
 * and no error. Only the flags that were given may override.
 */
export function overriding(payload: Record<string, unknown>, flags: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, ...given(flags) };
}

/** A write that names one thing still sends the API a list of one. */
export function one(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

export const YES_OPTION: OptionSpec = { name: '--yes', type: 'boolean', description: 'Confirm the deletion' };

export const FOLDER_OPTION: OptionSpec = {
  name: '--folder',
  type: 'string',
  placeholder: '<token>',
  description: 'Folder token; empty moves it out of any folder'
};

/**
 * `--mine` is a different range, not a narrower one: it reads what the caller
 * submitted to forms they need not own. The flags that describe the owner-side
 * question have no counterpart there, so naming one alongside --mine is
 * refused rather than quietly dropped.
 */
export function refuseWithMine(input: CommandInput, flags: readonly string[]): void {
  for (const flag of flags) {
    const value = input.options[flag];
    const given = Array.isArray(value) ? value.length > 0 : value !== undefined;
    if (given) throw new UsageError(`--${flag.replace(/_/g, '-')} cannot be combined with --mine`);
  }
}

/**
 * Keywords stay separate: the API matches a name containing any of them, and
 * joining them would ask for one keyword with a comma in it.
 */
export function keywords(value: unknown): readonly string[] | undefined {
  const values = value as string[] | undefined;
  return values && values.length > 0 ? values : undefined;
}

export const LISTING: Pagination = { items: 'data', cursor: 'next' };

/** A listing's rows cut down to the given keys, each named as the row has it. */
export function rowsForReading(
  body: unknown,
  row: (item: Record<string, unknown>) => Record<string, unknown>
): unknown {
  if (!isRecord(body) || !Array.isArray(body.data)) return body;
  return { ...body, data: body.data.map((item: unknown) => (isRecord(item) ? row(item) : item)) };
}

export function payload(input: CommandInput): unknown {
  const value = input.options.json;
  if (value === undefined) throw new UsageError('--json <json|@file|-> is required');
  return value;
}

export function requiredOption(input: CommandInput, key: string): string {
  const value = input.options[key] as string | undefined;
  if (!value) throw new UsageError(`--${key.replace(/_/g, '-')} is required`);
  return value;
}

/** Sending to entries belongs to a form: the API has no table counterpart. */
export const FORM_OPTION: OptionSpec = {
  name: '--form',
  type: 'string',
  placeholder: '<token>',
  description: 'Form token, six letters and digits, e.g. Kp7mQ2'
};

/** The entries a send picks, narrowed the way `entry count` narrows them. */
export const NARROWING_OPTIONS: readonly OptionSpec[] = [
  { name: '--keyword', type: 'string', placeholder: '<kw>', description: 'Search every searchable field at once' },
  {
    name: '--view',
    type: 'string',
    placeholder: '<view>',
    description: 'Only the entries this view shows; a filter narrows them further'
  },
  FILTER_OPTION,
  FILTERS_OPTION
];

/**
 * The API answers 400 rather than send to a whole form nothing narrowed, so
 * every entry is asked for out loud.
 */
export const SELECT_ALL_OPTION: OptionSpec = {
  name: '--select-all',
  type: 'boolean',
  description: 'Every entry of the form; needed when no filter, keyword or view narrows them'
};

export const ESTIMATE_OPTION: OptionSpec = {
  name: '--estimate',
  type: 'boolean',
  description: 'Estimate what it would send and cost, and send nothing'
};

export const SEND_OPTION: OptionSpec = { name: '--yes', type: 'boolean', description: 'Confirm the sending' };

/** The narrowing as a read sends it, the conditions as JSON text. */
export function narrowingQuery(input: CommandInput): Record<string, string | undefined> {
  return {
    filters: filters(input),
    keyword: input.options.keyword as string | undefined,
    view_token: input.options.view as string | undefined
  };
}

/** The narrowing as a write sends it, the conditions as they are. */
export function narrowingBody(input: CommandInput): Record<string, unknown> {
  return {
    filters: filterConditions(input),
    keyword: input.options.keyword as string | undefined,
    view_token: input.options.view as string | undefined
  };
}

export function selectAll(input: CommandInput): true | undefined {
  return input.options.select_all ? true : undefined;
}

/**
 * A send uses quota and cannot be recalled. Nothing here prompts, so the
 * sending is a flag, and leaving it out sends nothing.
 */
export function sendingConfirmed(input: CommandInput, what: string): void {
  if (!input.options.yes) throw new UsageError(`${what} uses quota and cannot be recalled; pass --yes to send`);
}

/** Whether to estimate instead of sending; a send still wants its --yes. */
export function estimating(input: CommandInput, what: string): boolean {
  if (input.options.estimate && input.options.yes)
    throw new UsageError('--estimate and --yes are alternatives, not both');
  if (input.options.estimate) return true;
  if (!input.options.yes) {
    throw new UsageError(
      `${what} uses quota and cannot be recalled; pass --estimate to see what it takes, or --yes to send`
    );
  }
  return false;
}
