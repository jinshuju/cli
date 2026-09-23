import {
  CONTAINER_LIST_OPTIONS,
  CONTAINER_OPTIONS,
  FILTER_OPTION,
  FILTERS_OPTION,
  JSON_OPTION,
  MINE_OPTION,
  PAGINATION_OPTIONS,
  SORT_OPTION,
  TIME_BUCKETS,
  UsageError,
  parseDimension,
  parseFilter,
  parseMetric,
  namedContainers,
  resolveContainer,
  resolveContainers,
  type OptionSpec
} from '../options.js';
import {
  API,
  LISTING,
  YES_OPTION,
  confirmed,
  containerPath,
  filters,
  given,
  paging,
  payload,
  refuseWithMine,
  requiredOption,
  sort
} from './shared.js';
import type { Command, CommandInput } from './types.js';
import { RefusedError } from '../errors.js';
import { progress } from '../progress.js';
import { TransportError, type HttpClient } from '../http.js';
import { isRecord } from '../values.js';
import { basename } from 'node:path';
import { upload } from './upload.js';

/** What the batch count endpoint accepts, and what the design document states. */
const MAX_COUNTED_CONTAINERS = 10;

function list(value: unknown): string | undefined {
  const values = value as string[] | undefined;
  return values && values.length > 0 ? values.join(',') : undefined;
}

function labels(input: CommandInput): string | undefined {
  return input.options.labels ? 'true' : undefined;
}

const LABELS_OPTION: OptionSpec = {
  name: '--labels',
  type: 'boolean',
  description: "Pair each value with its field's label, saving a second read of the form"
};

/**
 * `entry aggregate` answers a table taken apart: `columns` says what each
 * column is, `rows` holds one positional array per row and no names at all.
 * Nothing generic can put the two back together — a renderer given the rows
 * alone sees arrays of mixed things and prints them as JSON — so they are
 * zipped here, into the rows-of-objects every other listing already is.
 *
 * Only for reading. `--output json` keeps the positional shape: it is the one a
 * script can index by position without knowing what the labels say, and the
 * headings below are Chinese as often as not.
 */
function aggregateTable(body: unknown): unknown {
  const { columns, rows, ...rest } = (body ?? {}) as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(columns) || !Array.isArray(rows)) return body;

  const headings = uniqueHeadings(columns.map(headingOf));
  return {
    ...rest,
    rows: rows.map((row) => {
      const cells = Array.isArray(row) ? row : [row];
      return Object.fromEntries(headings.map((heading, index) => [heading, cellOf(cells[index])]));
    })
  };
}

/** `count(姓名)`, because `姓名` alone does not say what was done to it. */
function headingOf(column: unknown, index: number): string {
  const { label, field, func } = (column ?? {}) as { label?: string; field?: string; func?: string };
  const name = label || field || `column_${index + 1}`;
  return func ? `${func}(${name})` : name;
}

/** A dimension cell is the choice it grouped by; a metric cell is the number. */
function cellOf(cell: unknown): unknown {
  if (cell === null || typeof cell !== 'object' || Array.isArray(cell)) return cell;
  const { label } = cell as { label?: unknown };
  return label ?? JSON.stringify(cell);
}

/**
 * Two columns heading the same object would leave one of them silently
 * overwriting the other, so a repeat is numbered rather than lost.
 */
function uniqueHeadings(headings: string[]): string[] {
  const seen = new Map<string, number>();
  return headings.map((heading) => {
    const count = (seen.get(heading) ?? 0) + 1;
    seen.set(heading, count);
    return count === 1 ? heading : `${heading} (${count})`;
  });
}

/** `field_3=名称` or `field_3=2`: a label if it is not a column number. */
function parseColumnMapping(input: string): Record<string, string | number> {
  const at = input.indexOf('=');
  if (at <= 0) throw new UsageError(`--map must be '<api-code>=<column>', got ${JSON.stringify(input)}`);
  const field_api_code = input.slice(0, at);
  const column = input.slice(at + 1);
  if (!column) throw new UsageError(`--map needs a column after '=', got ${JSON.stringify(input)}`);
  return /^\d+$/.test(column)
    ? { field_api_code, sheet_column_index: Number.parseInt(column, 10) }
    : { field_api_code, column_label: column };
}

type Attachment = { field: string; row: number; dimension?: string; file: string };

const ATTACH_SHAPE = "--attach must be '<api-code>=<file>', or '<api-code>.<row>.<sub>=<file>' for a subtable column";

/**
 * `field_5=/path/a.png`, or `field_5.0.field_2=/path/a.png` for one row of a
 * subtable column.
 *
 * A subtable answer is a list of rows, so the file belongs in one of them and
 * the row has to be named. Without a row it is the first, which is what a
 * subtable filled in one go almost always has.
 *
 * The row is a dot and not a bracket because zsh reads `field_5[0]` as a
 * pattern and refuses the command before the CLI sees it — a syntax that needs
 * quoting to be typed at all is the wrong one to hand somebody. `[0]` is still
 * accepted, for anyone who quotes it or arrives from another tool.
 */
function parseAttachment(input: string): Attachment {
  const at = input.indexOf('=');
  if (at <= 0) throw new UsageError(`${ATTACH_SHAPE}, got ${JSON.stringify(input)}`);

  const file = input.slice(at + 1);
  const target = /^([A-Za-z0-9_]+)(?:\[(\d+)\]|\.(\d+))?(?:\.([A-Za-z0-9_]+))?$/.exec(input.slice(0, at));
  if (!target || !file) throw new UsageError(`${ATTACH_SHAPE}, got ${JSON.stringify(input)}`);

  const [, field, bracketed, dotted, dimension] = target as unknown as [
    string,
    string,
    string | undefined,
    string | undefined,
    string | undefined
  ];
  const row = bracketed ?? dotted;
  if (row !== undefined && dimension === undefined) {
    throw new UsageError(`a row needs the subtable column it is a row of: ${field}.${row}.<sub>=<file>`);
  }
  return { field, row: row === undefined ? 0 : Number(row), dimension, file };
}

interface ImportJob {
  readonly job_id: string;
  readonly status: string;
  readonly total_rows?: number | null;
  readonly processed_rows?: number | null;
  readonly error_message?: string | null;
}

/** The states an import stops in; the rest mean it is still going. */
const IMPORT_SETTLED = new Set(['success', 'failed', 'cancelled']);

const IMPORT_POLL_MS = 1000;

/**
 * How long `--wait` waits before giving up. An import of any size the plan
 * allows finishes well inside this; one that has not is stuck, and a command
 * that never returns is worse than one that says so and names the job.
 */
export const IMPORT_WAIT_MS = 30 * 60 * 1000;

export type Waiting = {
  step(message: string): void;
  /** How long to wait in all; tests shorten it. */
  deadlineMs?: number;
  /** How to pause between polls, and what time it is; tests replace both. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Waits for the rows to be written. A failed import exits non-zero, because
 * the alternative — answering 0 for an import that wrote nothing — is how a
 * caller comes to believe data is there when it is not.
 */
export async function awaitImport(
  client: HttpClient,
  token: string,
  jobId: string,
  watching: Waiting
): Promise<ImportJob> {
  const deadlineMs = watching.deadlineMs ?? IMPORT_WAIT_MS;
  const sleep = watching.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = watching.now ?? Date.now;
  const started = now();
  // Every way out of this loop but the good one carries the job id. The rows are
  // already being written by the time the first poll happens, so an error that
  // drops the id leaves the caller unable to ask how it went and tempted to
  // import the file a second time.
  const recoverable = (reason: string, cause?: unknown): Error =>
    new (cause === undefined ? RefusedError : Error)(
      `${reason}. The import is job ${jobId} and may still be running: ` +
        `jinshuju entry import-status --form ${token} ${jobId}`,
      { cause }
    );
  const stillRunning = (): Error =>
    new TransportError(
      `gave up waiting after ${Math.round(deadlineMs / 60_000)} minutes. The import is job ${jobId} and is still running: ` +
        `jinshuju entry import-status --form ${token} ${jobId}`,
      true
    );

  for (;;) {
    let job: ImportJob;
    try {
      job = await client.request<ImportJob>({
        method: 'GET',
        path: `${API}/forms/${token}/entry_imports/${jobId}`
      });
    } catch (error) {
      throw recoverable(`the import started, but asking how it is going failed: ${(error as Error).message}`, error);
    }
    if (IMPORT_SETTLED.has(job.status)) {
      if (job.status !== 'success') {
        throw recoverable(`import ${job.status}${job.error_message ? `: ${job.error_message}` : ''}`);
      }
      return job;
    }
    const seen = job.processed_rows ?? 0;
    const total = job.total_rows;
    watching.step(`importing ${seen}${total ? `/${total}` : ''} rows…`);
    if (now() - started >= deadlineMs) throw stillRunning();
    await sleep(IMPORT_POLL_MS);
  }
}

const BATCH_OPTION: OptionSpec = {
  name: '--batch',
  type: 'json',
  placeholder: '<json|@file|->',
  description: 'Several rows in one request'
};

function attachments(input: CommandInput): Attachment[] {
  return ((input.options.attach as string[] | undefined) ?? []).map(parseAttachment);
}

/** An attachment slot holds a list, so a second file joins the first. */
function append(existing: unknown, id: string): string[] {
  return Array.isArray(existing) ? [...(existing as string[]), id] : [id];
}

function batchRows(input: CommandInput): unknown[] | undefined {
  const rows = input.options.batch;
  if (rows === undefined) return undefined;
  if (input.options.json !== undefined) throw new UsageError('--json and --batch are alternatives, not both');
  if (!Array.isArray(rows)) throw new UsageError('--batch must be a list');
  return rows;
}

/**
 * Batch writes are served under the forms path alone, and it takes a table's
 * token just as well, so a table batches through the same URL.
 */
function batchPath(input: CommandInput): string {
  const { token } = resolveContainer(input.options);
  return `${API}/forms/${token}/entries/batch`;
}

export const ENTRY: readonly Command[] = [
  {
    path: ['entry', 'list'],
    summary: 'List entries',
    description:
      'With --view the view carries its own filter and sort, so --filter, --keyword and --sort cannot be added on top.',
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--view', type: 'string', placeholder: '<view>', description: 'Read the entries of this view' },
      { name: '--keyword', type: 'string', placeholder: '<kw>', description: 'Search every searchable field at once' },
      { name: '--fields', type: 'list', placeholder: '<api-code,...>', description: 'Return only these fields' },
      LABELS_OPTION,
      MINE_OPTION,
      FILTER_OPTION,
      FILTERS_OPTION,
      SORT_OPTION,
      ...PAGINATION_OPTIONS
    ],
    request: (input) => {
      if (input.options.mine) {
        refuseWithMine(input, ['view', 'sort']);
        const { token } = resolveContainer(input.options);
        return {
          method: 'GET',
          path: `${API}/my/forms/${token}/entries`,
          query: {
            filters: filters(input),
            keyword: input.options.keyword as string | undefined,
            fields: list(input.options.fields),
            include_labels: labels(input),
            ...paging(input)
          }
        };
      }
      const view = input.options.view as string | undefined;
      if (view) {
        for (const flag of ['filter', 'filters', 'keyword', 'sort'] as const) {
          const value = input.options[flag];
          if (Array.isArray(value) ? value.length > 0 : value !== undefined) {
            throw new UsageError(`--${flag} cannot be combined with --view: the view carries its own filter and sort`);
          }
        }
        // The view decides its own columns and the endpoint takes no field
        // list, so --fields here asked for something that was never going to
        // happen. Refusing beats accepting it and answering every field.
        if (input.options.fields !== undefined) {
          throw new UsageError(
            '--fields cannot be combined with --view: the view decides its own columns. ' +
              'Change them with `view edit --columns`, or read the form without --view.'
          );
        }
        return {
          method: 'GET',
          path: `${containerPath(input)}/views/${view}/entries`,
          query: { include_labels: labels(input), ...paging(input) }
        };
      }
      return {
        method: 'GET',
        path: `${containerPath(input)}/entries`,
        query: {
          filters: filters(input),
          keyword: input.options.keyword as string | undefined,
          fields: list(input.options.fields),
          include_labels: labels(input),
          sort: sort(input, 'api_code'),
          ...paging(input)
        }
      };
    },
    paginate: LISTING,
    examples: [
      'jinshuju entry list --form Kp7mQ2',
      "jinshuju entry list --form Kp7mQ2 --filter 'field_3 gte 80' --sort created_at:desc",
      'jinshuju entry list --form Kp7mQ2 --all',
      'jinshuju entry list --form Kp7mQ2 --mine'
    ]
  },
  {
    path: ['entry', 'count'],
    summary: 'Count the entries matching a filter',
    description:
      'The container is repeatable, up to 10. Counting several at once answers one row each plus the ' +
      'sum, and takes no --keyword; a filter then has to name created_at, updated_at or creator_id, ' +
      'because an api_code is a different field on every form.',
    options: [
      ...CONTAINER_LIST_OPTIONS,
      { name: '--keyword', type: 'string', placeholder: '<kw>', description: 'Search every searchable field at once' },
      FILTER_OPTION,
      FILTERS_OPTION
    ],
    request: (input) => {
      const { tokens, kind } = resolveContainers(input.options, MAX_COUNTED_CONTAINERS);
      const query = { filters: filters(input), keyword: input.options.keyword as string | undefined };
      if (tokens.length === 1) {
        return {
          method: 'GET',
          path: `${API}/${kind === 'table' ? 'tables' : 'forms'}/${tokens[0]}/entries/count`,
          query
        };
      }
      return { method: 'GET', path: `${API}/entries/count`, query: { ...query, form_tokens: tokens.join(',') } };
    },
    examples: [
      "jinshuju entry count --form Kp7mQ2 --filter 'field_3 gte 80'",
      'jinshuju entry count --form Kp7mQ2 --form Vn4xR8 --form aB3dE9'
    ]
  },
  {
    path: ['entry', 'search'],
    summary: 'Search several forms for one keyword at once',
    description:
      'Answers, per form, how many entries matched and some of their serial numbers; values are ' +
      'never returned. Read what you need afterwards with `entry get` or `entry list --keyword`. ' +
      'A form that matched nothing is left out, so a token you named and cannot find was searched ' +
      'and matched nothing. A form that could not be searched is listed with a reason instead — ' +
      '"not searched" is not "no match". Name up to 10 containers, or name none and let ' +
      '--scope-filter describe them; the call is refused rather than truncated when more than 10 match.',
    args: [{ name: 'keyword', required: true, description: 'The text to search for' }],
    options: [
      ...CONTAINER_LIST_OPTIONS,
      {
        name: '--scope-filter',
        type: 'string',
        repeatable: true,
        placeholder: "'<field> <op> [value]'",
        description:
          'Which forms to search, not which entries match. Takes form_name, created_at, ' +
          'last_entry_created_at, entries_count. Empty forms are skipped unless you say otherwise'
      },
      MINE_OPTION
    ],
    request: (input) => {
      const { tokens } = namedContainers(input.options);
      if (input.options.mine) {
        refuseWithMine(input, ['table', 'scope_filter']);
        return {
          method: 'GET',
          path: `${API}/my/search`,
          query: {
            keyword: input.args.keyword,
            form_tokens: tokens.length > 0 ? tokens.join(',') : undefined
          }
        };
      }
      const scope = (input.options.scope_filter as string[] | undefined) ?? [];
      return {
        method: 'GET',
        path: `${API}/entries/search`,
        query: {
          keyword: input.args.keyword,
          form_tokens: tokens.length > 0 ? tokens.join(',') : undefined,
          filters: scope.length > 0 ? JSON.stringify(scope.map(parseFilter)) : undefined
        }
      };
    },
    examples: [
      'jinshuju entry search 某某公司',
      'jinshuju entry search 13800138000 --form Kp7mQ2 --form Vn4xR8',
      "jinshuju entry search 报修 --scope-filter 'entries_count gt 100'",
      'jinshuju entry search 某某公司 --mine'
    ]
  },
  {
    path: ['entry', 'stats'],
    summary: 'Count submissions per form over a date range',
    description:
      'Not the question `entry count` answers. These are submissions as they happened: an import ' +
      'lands on the day it ran whatever dates its rows carry, and deletions are never subtracted, ' +
      'so this is how much arrived rather than how much is still there. A whole day is the ' +
      'smallest window; both ends are inclusive and days are cut in the reported time zone.',
    options: [
      { name: '--from', type: 'string', placeholder: '<YYYY-MM-DD>', description: 'First day to count, inclusive' },
      {
        name: '--to',
        type: 'string',
        placeholder: '<YYYY-MM-DD>',
        description: 'Last day to count, inclusive. Defaults to today'
      },
      {
        name: '--kind',
        type: 'string',
        choices: ['form', 'table'],
        placeholder: '<kind>',
        description: 'Count only forms, or only tables'
      },
      {
        name: '--limit',
        type: 'integer',
        placeholder: '<n>',
        description: 'How many forms to list, most submissions first (default 100, max 100)'
      }
    ],
    request: (input) => ({
      method: 'GET',
      path: `${API}/entries/stats`,
      query: {
        from: requiredOption(input, 'from'),
        to: input.options.to as string | undefined,
        kind: input.options.kind as string | undefined,
        limit: input.options.limit === undefined ? undefined : String(input.options.limit)
      }
    }),
    examples: [
      'jinshuju entry stats --from 2026-09-01',
      'jinshuju entry stats --from 2026-09-01 --to 2026-09-07 --kind form --limit 10'
    ]
  },
  {
    path: ['entry', 'aggregate'],
    summary: 'Compute statistics over the entries matching a filter',
    description:
      'The response is as big as the metrics and groups asked for, never as big as the data. Which ' +
      "functions a field takes is the field's own answer: read analytics.agg_funcs from `form get`.",
    options: [
      ...CONTAINER_OPTIONS,
      {
        name: '--metric',
        type: 'string',
        repeatable: true,
        placeholder: '<func>:<field>',
        description: 'Statistic to compute, repeatable, 1 to 20. e.g. avg:field_3'
      },
      {
        name: '--by',
        type: 'string',
        repeatable: true,
        placeholder: `<field>[:${TIME_BUCKETS.join('|')}]`,
        description: 'Group by this field, repeatable, at most 2. A date field needs a bucket'
      },
      {
        name: '--limit',
        type: 'integer',
        placeholder: '<n>',
        description: 'How many groups, ranked by the first metric (default 20, max 200)'
      },
      FILTER_OPTION,
      FILTERS_OPTION
    ],
    request: (input) => {
      const metrics = (input.options.metric as string[] | undefined) ?? [];
      if (metrics.length === 0) throw new UsageError('--metric <func>:<field> is required, up to 20');
      const dimensions = (input.options.by as string[] | undefined) ?? [];
      return {
        method: 'GET',
        path: `${containerPath(input)}/entries/aggregate`,
        query: {
          metrics: JSON.stringify(metrics.map(parseMetric)),
          dimensions: dimensions.length > 0 ? JSON.stringify(dimensions.map(parseDimension)) : undefined,
          limit: input.options.limit === undefined ? undefined : String(input.options.limit),
          filters: filters(input)
        }
      };
    },
    render: aggregateTable,
    examples: [
      'jinshuju entry aggregate --form Kp7mQ2 --metric avg:field_3',
      'jinshuju entry aggregate --form Kp7mQ2 --metric count:field_1 --by created_at:month',
      "jinshuju entry aggregate --form Kp7mQ2 --metric sum:field_5 --by field_7 --limit 5 --filter 'created_at within_last 30d'"
    ]
  },
  {
    path: ['entry', 'summary'],
    summary: 'Profile every analysable field at once',
    // The buckets are what a profile is; a table that drops them says nothing.
    text: { essentialLists: ['buckets'] },
    description:
      'One pass over the data describing each field in its own terms: choices by share, numbers by ' +
      'spread, dates by range. Submission metadata is left out — it describes the submitting, not the answer.',
    options: [
      ...CONTAINER_OPTIONS,
      {
        name: '--fields',
        type: 'list',
        placeholder: '<api-code,...>',
        description: 'Profile only these fields, at most 60'
      },
      { name: '--no-overview', type: 'boolean', description: 'Leave out the form-level totals' },
      FILTER_OPTION,
      FILTERS_OPTION
    ],
    request: (input) => ({
      method: 'GET',
      path: `${containerPath(input)}/entries/summary`,
      query: {
        fields: list(input.options.fields),
        include_overview: input.options.no_overview ? 'false' : undefined,
        filters: filters(input)
      }
    }),
    examples: [
      'jinshuju entry summary --form Kp7mQ2',
      'jinshuju entry summary --form Kp7mQ2 --fields field_3,field_7 --no-overview'
    ]
  },
  {
    path: ['entry', 'create'],
    summary: 'Create entries',
    description:
      'The payload is keyed by field api_code, not by field label. --batch takes a list of them and ' +
      'writes them in one request.',
    options: [
      ...CONTAINER_OPTIONS,
      JSON_OPTION,
      BATCH_OPTION,
      {
        name: '--attach',
        type: 'string',
        repeatable: true,
        placeholder: '<api-code>[.<row>.<sub>]=<file>',
        description:
          'Upload a file into this attachment field, repeatable. A subtable column names the row it fills: field_5.0.field_2=<file>'
      }
    ],
    run: async (input, client) => {
      const attached = attachments(input);
      const batch = batchRows(input);
      if (attached.length === 0) {
        if (batch) return client.request({ method: 'POST', path: batchPath(input), body: { entries: batch } });
        return client.request({ method: 'POST', path: `${containerPath(input)}/entries`, body: payload(input) });
      }
      if (batch !== undefined) throw new UsageError('--attach cannot be combined with --batch');

      const container = containerPath(input);
      const { token } = resolveContainer(input.options);
      const body = { ...(input.options.json as Record<string, unknown> | undefined) };
      const watching = progress();
      try {
        for (const { field, row, dimension, file } of attached) {
          watching.step(`uploading ${basename(file)}…`);
          const uploaded = await client.request<{ id: string }>(
            upload(
              `${API}/forms/${token}/entry_attachments`,
              file,
              dimension === undefined
                ? { field_api_code: field }
                : { field_api_code: field, dimension_api_code: dimension }
            )
          );
          // A field holds a list of attachments, so each upload appends rather
          // than replacing what an earlier --attach for the same field put there.
          if (dimension === undefined) {
            body[field] = append(body[field], uploaded.id);
            continue;
          }
          // A subtable column is a list of rows and the file lives inside one of
          // them: {"field_5": [{"field_2": ["<id>"]}]}. Writing "field_5.field_2"
          // at the top level named no field the form has, so the server dropped it
          // and answered with an entry created — without the file just uploaded.
          const rows = Array.isArray(body[field]) ? [...(body[field] as unknown[])] : [];
          while (rows.length <= row) rows.push({});
          const cells = { ...(isRecord(rows[row]) ? (rows[row] as Record<string, unknown>) : {}) };
          cells[dimension] = append(cells[dimension], uploaded.id);
          rows[row] = cells;
          body[field] = rows;
        }
        return await client.request({ method: 'POST', path: `${container}/entries`, body });
      } finally {
        watching.done();
      }
    },
    examples: [
      'jinshuju entry create --form Kp7mQ2 --json \'{"field_1":"张三"}\'',
      'jinshuju entry create --form Kp7mQ2 --json @entry.json --attach field_5=./id-card.jpg',
      'jinshuju entry create --form Kp7mQ2 --json \'{"field_2":[{"field_1":"高铁票"}]}\' --attach field_2.0.field_2=./invoice.pdf',
      'jinshuju entry create --form Kp7mQ2 --batch @entries.json'
    ]
  },
  {
    path: ['entry', 'update'],
    summary: 'Update entries',
    description:
      'The payload merges onto the entry, leaving the fields it does not name alone; --replace ' +
      'writes the entry as given, clearing the rest. --batch takes [{serial_number, entry}] and ' +
      'always merges.',
    args: [{ name: 'serial', required: false, description: 'Entry serial number; leave out with --batch' }],
    options: [
      ...CONTAINER_OPTIONS,
      JSON_OPTION,
      BATCH_OPTION,
      {
        name: '--replace',
        type: 'boolean',
        description: 'Write the entry as given, clearing fields the payload leaves out'
      }
    ],
    request: (input) => {
      const batch = batchRows(input);
      if (batch) {
        if (input.args.serial) throw new UsageError('--batch carries its own serial numbers, so <serial> is not taken');
        if (input.options.replace) throw new UsageError('--replace cannot be combined with --batch');
        return { method: 'PATCH', path: batchPath(input), body: { entries: batch } };
      }
      if (!input.args.serial) throw new UsageError('<serial> is required, or pass --batch');
      return {
        method: input.options.replace ? 'PUT' : 'PATCH',
        path: `${containerPath(input)}/entries/${input.args.serial}`,
        body: payload(input)
      };
    },
    examples: [
      'jinshuju entry update --form Kp7mQ2 12 --json \'{"field_1":"李四"}\'',
      'jinshuju entry update --form Kp7mQ2 --batch @rows.json'
    ]
  },
  {
    path: ['entry', 'import'],
    summary: 'Import a spreadsheet into a form or table',
    description:
      'Two requests underneath: the file goes up, then the mapping says which column feeds which ' +
      'field. Everything knowable up front — the file, the size your plan allows, the header row, ' +
      'the mapping — is checked before any row is written, so a refused import has changed nothing ' +
      "and the message names the sheet's real layout. Once accepted the rows are written in the " +
      'background: the answer means started, not finished.',
    args: [{ name: 'file', required: true, description: 'Path to an .xlsx, .xls or .csv file' }],
    options: [
      ...CONTAINER_OPTIONS,
      {
        name: '--map',
        type: 'string',
        repeatable: true,
        placeholder: '<api-code>=<column>',
        description: 'Which column feeds which field. A number is a column index, anything else a header label'
      },
      {
        name: '--header-row',
        type: 'integer',
        placeholder: '<n>',
        description: 'Which row holds the headers, when it is not the first'
      },
      {
        name: '--unique',
        type: 'string',
        placeholder: '<api-code>',
        description: 'Treat this field as the key: a row matching an existing one updates it'
      },
      {
        name: '--wait',
        type: 'boolean',
        description: 'Wait for the rows to be written and report what the import did, failing if it failed'
      }
    ],
    run: async (input, client) => {
      const { token } = resolveContainer(input.options);
      const mappings = (input.options.map as string[] | undefined) ?? [];
      if (mappings.length === 0) throw new UsageError('--map <api-code>=<column> is required, at least once');

      const watching = progress();
      try {
        watching.step(`uploading ${basename(input.args.file as string)}…`);
        const uploaded = await client.request<{ id: string }>(
          upload(`${API}/forms/${token}/import_files`, input.args.file as string)
        );

        watching.step('starting the import…');
        const started = await client.request<ImportJob>({
          method: 'POST',
          path: `${API}/forms/${token}/entry_imports`,
          body: given({
            attachment_id: uploaded.id,
            columns: mappings.map(parseColumnMapping),
            header_row_index: input.options.header_row,
            unique_field_code: input.options.unique
          })
        });
        if (!input.options.wait) return started;

        return await awaitImport(client, token, started.job_id, watching);
      } finally {
        watching.done();
      }
    },
    examples: [
      'jinshuju entry import --form Kp7mQ2 ./报名.xlsx --map field_1=姓名 --map field_2=手机号',
      'jinshuju entry import --form Kp7mQ2 ./报名.xlsx --map field_1=姓名 --wait',
      'jinshuju entry import --table Vn4xR8 ./rows.csv --map field_1=1 --map field_2=2 --header-row 2'
    ]
  },
  {
    path: ['entry', 'import-status'],
    summary: 'Show what an import did, or how far it has got',
    description:
      'The id `entry import` answered with. A finished import reports how many rows it wrote, ' +
      'skipped and rejected; one still running reports how far it has got.',
    args: [{ name: 'job', required: true, description: 'Job id from `entry import`' }],
    options: [...CONTAINER_OPTIONS],
    request: (input) => {
      const { token } = resolveContainer(input.options);
      return { method: 'GET', path: `${API}/forms/${token}/entry_imports/${input.args.job}` };
    },
    examples: ['jinshuju entry import-status --form Kp7mQ2 6ab12edb3134316548d106a9']
  },
  {
    path: ['entry', 'delete'],
    summary: 'Delete one entry',
    args: [{ name: 'serial', required: true, description: 'Entry serial number' }],
    options: [...CONTAINER_OPTIONS, YES_OPTION],
    request: (input) => {
      confirmed(input, `Deleting entry ${input.args.serial}`);
      return { method: 'DELETE', path: `${containerPath(input)}/entries/${input.args.serial}` };
    },
    examples: ['jinshuju entry delete --form Kp7mQ2 12 --yes']
  },
  {
    path: ['entry', 'get'],
    summary: 'Show one entry',
    args: [{ name: 'serial', required: true, description: 'Entry serial number' }],
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--fields', type: 'list', placeholder: '<api-code,...>', description: 'Return only these fields' },
      LABELS_OPTION
    ],
    request: (input) => ({
      method: 'GET',
      path: `${containerPath(input)}/entries/${input.args.serial}`,
      query: { fields: list(input.options.fields), include_labels: labels(input) }
    })
  }
];
