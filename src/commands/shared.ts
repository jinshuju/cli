import { HttpError } from '../errors.js';
import type { HttpClient, HttpRequest } from '../http.js';
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
  const given = (input.options.filter as string[] | undefined) ?? [];
  // JSON handed to --filter is what --filters takes, and can mean nothing else;
  // refusing it only sent the caller off to read help.
  const json = given.filter(looksLikeJson);
  const compact = given.filter((item) => !looksLikeJson(item));
  const raw = input.options.filters;
  if ([raw !== undefined, json.length > 0, compact.length > 0].filter(Boolean).length > 1) {
    throw new UsageError('--filter and --filters are alternatives, not both');
  }
  if (raw !== undefined) return Array.isArray(raw) ? raw.map(withOperator) : raw;
  if (json.length > 0) return json.flatMap(parseJsonFilter).map(withOperator);
  if (compact.length === 0) return undefined;
  const conditions: FilterCondition[] = compact.map(parseFilter);
  return conditions;
}

function looksLikeJson(value: string): boolean {
  return /^\s*[[{]/.test(value);
}

/** One condition or a list of them, as JSON. */
function parseJsonFilter(value: string): unknown[] {
  try {
    return [JSON.parse(value) as unknown].flat();
  } catch {
    throw new UsageError(`--filter looks like JSON but does not parse: ${JSON.stringify(value)}`);
  }
}

/**
 * The API names the key `operator`. `op` is written for it often enough, and
 * means nothing else, so it is renamed rather than refused.
 */
function withOperator(condition: unknown): unknown {
  if (!isRecord(condition) || !('op' in condition) || 'operator' in condition) return condition;
  const { op, ...rest } = condition;
  return { ...rest, operator: op };
}

export function filters(input: CommandInput): string | undefined {
  const conditions = filterConditions(input);
  const folders = (input.options.folder as string[] | undefined) ?? [];
  if (folders.length === 0) return conditions === undefined ? undefined : JSON.stringify(conditions);
  // A folder is one more condition on the listing, AND-ed with the rest.
  const rest = conditions === undefined ? [] : [conditions].flat();
  return JSON.stringify([...rest, { field: 'folder_token', operator: 'any_in', value: folders }]);
}

/** Only what is filed in these folders, as the caller sees them. */
export const FOLDER_FILTER_OPTION: OptionSpec = {
  name: '--folder',
  type: 'string',
  repeatable: true,
  placeholder: '<folder>',
  description: 'Only what is filed in this folder (its folder_token), repeatable'
};

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
export function confirmed(input: CommandInput, what: string, outcome = 'is permanent'): void {
  if (!input.options.yes) throw new UsageError(`${what} ${outcome}; pass --yes to go ahead`);
}

/**
 * How many forms or tables one delete takes. A delete that has to be confirmed
 * first, as Jiri's are, reads what each one would take with it before asking,
 * and one confirmation covers at most this many: taking more would read ahead
 * for batches nobody is asked about yet.
 */
const TRASH_BATCH = 20;

/**
 * How many of a batch's requests are in flight at once. Each form or table is a
 * request of its own, and a batch of 20 sent one after another took seconds; a
 * few at a time stays well inside what the API takes from one caller.
 */
const TRASH_CONCURRENCY = 5;

type Outcome<T> = { token: string; value: T } | { token: string; error: Error };

/**
 * Sends one request per token and answers every outcome, in the order given. The
 * first goes alone, so a session that has to refresh its token does so once
 * rather than from several requests at the same moment; the rest a few at a time.
 */
async function eachToken<T>(tokens: readonly string[], send: (token: string) => Promise<T>): Promise<Outcome<T>[]> {
  const settle = (token: string): Promise<Outcome<T>> =>
    send(token).then(
      (value) => ({ token, value }),
      (error: unknown) => ({ token, error: error as Error })
    );
  const outcomes = [await settle(tokens[0]!)];
  let next = 1;
  const worker = async (): Promise<void> => {
    while (next < tokens.length) {
      const index = next++;
      outcomes[index] = await settle(tokens[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRASH_CONCURRENCY, tokens.length - 1) }, worker));
  return outcomes;
}

/**
 * Moves each form or table named to the trash, one request apiece, a few at a
 * time (`eachToken`). Every one is tried, so one refused does not leave the rest
 * standing, and the error lists what went beside what did not: read as
 * all-or-nothing, it would invite the moved ones to be deleted again or the
 * refused ones to be taken for done. It exits the way the first failure would
 * have, and under `--output json` its body carries every token's refusal, not
 * the first one's alone.
 */
export async function trash(
  client: HttpClient,
  input: CommandInput,
  kind: 'form' | 'table'
): Promise<{ deleted: string[] } | { previews: unknown[]; failures?: unknown[] }> {
  if (input.rest.length > TRASH_BATCH) {
    throw new UsageError(
      `${kind} delete takes at most ${TRASH_BATCH} ${kind}s at a time, got ${input.rest.length}; ` +
        'delete the rest in another call once these are done'
    );
  }
  if (input.options.preview) {
    if (input.options.yes) throw new UsageError('--preview and --yes are alternatives, not both');
    return previewTrash(client, input, kind);
  }
  const many = input.rest.length > 1;
  confirmed(
    input,
    `Deleting ${kind}${many ? 's' : ''} ${input.rest.join(', ')}`,
    `moves ${many ? 'them' : 'it'} to the trash`
  );
  const outcomes = await eachToken(input.rest, (token) =>
    client.request(
      kind === 'form'
        ? call('deleteForm', { path: { form_token: token } })
        : call('deleteTable', { path: { table_token: token } })
    )
  );
  const deleted = outcomes.flatMap((outcome) => ('value' in outcome ? [outcome.token] : []));
  const failures = outcomes.flatMap((outcome) => ('error' in outcome ? [outcome] : []));
  if (failures.length === 0) return { deleted };

  const lines = failures.map(({ token, error }) => {
    const outcome = error instanceof HttpError ? 'not deleted' : 'may or may not be deleted';
    return `  ${token} ${outcome}: ${error.message.replaceAll('\n', '\n    ')}`;
  });
  const first = failures[0]!.error;
  const body = {
    deleted,
    failures: failures.map(({ token, error }) =>
      error instanceof HttpError ? { token, status: error.status, body: error.body } : { token, message: error.message }
    )
  };
  throw new Error([`moved to the trash: ${deleted.join(', ') || 'none'}`, ...lines].join('\n'), {
    cause: first instanceof HttpError ? new HttpError(first.message, first.status, body) : first
  });
}

/**
 * What deleting each form or table would take with it, nothing deleted, a few at
 * a time (`eachToken`). A token that cannot be read is listed under `failures`
 * beside the ones that could, so one wrong token does not hide the rest; only
 * when none could be read does it fail, as its first failure would. Both keep
 * the order given.
 */
async function previewTrash(
  client: HttpClient,
  input: CommandInput,
  kind: 'form' | 'table'
): Promise<{ previews: unknown[]; failures?: unknown[] }> {
  const outcomes = await eachToken(input.rest, (token) =>
    client.request(
      kind === 'form'
        ? call('previewFormDeletion', { path: { form_token: token } })
        : call('previewTableDeletion', { path: { table_token: token } })
    )
  );
  const previews = outcomes.flatMap((outcome) => ('value' in outcome ? [outcome.value] : []));
  const failures = outcomes.flatMap((outcome) => ('error' in outcome ? [outcome] : []));
  if (previews.length === 0) throw failures[0]!.error;
  if (failures.length === 0) return { previews };
  return {
    previews,
    failures: failures.map(({ token, error }) =>
      error instanceof HttpError
        ? { token, status: error.status, message: error.message }
        : { token, message: error.message }
    )
  };
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

/** `form delete` and `table delete`'s look before they delete. */
export const PREVIEW_OPTION: OptionSpec = {
  name: '--preview',
  type: 'boolean',
  description: 'Show what deleting each would take with it, and delete nothing'
};

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
