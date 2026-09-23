import {
  UsageError,
  parseFilter,
  parseSort,
  resolveContainer,
  type FilterCondition,
  type OptionSpec,
  type SortRule
} from '../options.js';
import type { CommandInput, Pagination } from './types.js';

/** What more than one resource's commands build their requests from. */

export const API = '/api/v1';

/** The path segment a container lives under. */
export function containerPath(input: CommandInput): string {
  const { token, kind } = resolveContainer(input.options);
  return `${API}/${kind === 'table' ? 'tables' : 'forms'}/${token}`;
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

export function paging(input: CommandInput): Record<string, string | undefined> {
  return {
    limit: input.options.limit === undefined ? undefined : String(input.options.limit),
    next: input.options.next as string | undefined
  };
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
