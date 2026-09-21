import {
  CONTAINER_LIST_OPTIONS, CONTAINER_OPTIONS, FILTER_OPTION, FILTERS_OPTION, JSON_OPTION, LIMIT_OPTION,
  PAGINATION_OPTIONS, SORT_OPTION, TIME_BUCKETS, UsageError, parseDimension, parseFilter, parseMetric, parseSort,
  resolveContainer, resolveContainers, type FilterCondition, type OptionSpec, type SortRule
} from './options.js';
import { validateCreateFormPayload } from './payload.js';

/**
 * Every command the CLI has, as data.
 *
 * The shape follows the command design (D19293): `jinshuju <resource> <verb>
 * [args] [flags]`, resources kept at one level, the parent given by a flag —
 * `entry list --form <token>`, not `form entry list <token>`. Help, argument
 * checking and dispatch all read this table, so a command cannot be reachable
 * without its help, nor accept a flag it never described.
 */

export interface ArgSpec {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
}

/** How a listing returns its next page, which is what `--all` follows. */
export interface Pagination {
  readonly items: string;
  readonly cursor: string;
}

export interface CommandInput {
  readonly args: Record<string, string>;
  readonly options: Record<string, unknown>;
}

export interface Command {
  /** The words that select it: `['entry', 'list']`. */
  readonly path: readonly string[];
  /** One line, shown under its resource in the root help. */
  readonly summary: string;
  readonly description?: string;
  readonly args?: readonly ArgSpec[];
  readonly options?: readonly OptionSpec[];
  readonly examples?: readonly string[];
  readonly request?: (input: CommandInput) => HttpRequest;
  readonly paginate?: Pagination;
  /**
   * Narrows the response to what the command is about. `field list` asks for a
   * form because that is where fields live, but a caller asked for the fields.
   */
  readonly select?: (body: unknown) => unknown;
}

export interface Resource {
  readonly name: string;
  readonly summary: string;
}

/** Resource order in the root help, and the one-liner each gets. */
export const RESOURCES: readonly Resource[] = [
  { name: 'auth', summary: 'Manage authentication' },
  { name: 'account', summary: 'Account and members' },
  { name: 'folder', summary: 'Manage folders' },
  { name: 'form', summary: 'Manage forms' },
  { name: 'table', summary: 'Manage tables' },
  { name: 'field', summary: 'Manage fields' },
  { name: 'view', summary: 'Manage views' },
  { name: 'entry', summary: 'Manage entries' },
  { name: 'comment', summary: 'Manage entry comments' },
  { name: 'opensearch', summary: 'Manage public queries' },
  { name: 'config', summary: 'Manage CLI configuration' }
];

// --- shared request building ----------------------------------------------

const API = '/api/v1';

/** The path segment a container lives under. */
function containerPath(input: CommandInput): string {
  const { token, kind } = resolveContainer(input.options);
  return `${API}/${kind === 'table' ? 'tables' : 'forms'}/${token}`;
}

function filters(input: CommandInput): string | undefined {
  const compact = (input.options.filter as string[] | undefined) ?? [];
  const raw = input.options.filters;
  if (raw !== undefined && compact.length > 0) {
    throw new UsageError('--filter and --filters are alternatives, not both');
  }
  if (raw !== undefined) return JSON.stringify(raw);
  if (compact.length === 0) return undefined;
  const conditions: FilterCondition[] = compact.map(parseFilter);
  return JSON.stringify(conditions);
}

function sort(input: CommandInput, key: 'api_code' | 'field'): string | undefined {
  const rules = (input.options.sort as string[] | undefined) ?? [];
  if (rules.length === 0) return undefined;
  // The API names a sort key `api_code` for data and `field` for listings; the
  // CLI shows one `--sort <field>:<order>` and translates here.
  return JSON.stringify(rules.map(parseSort).map((rule: SortRule) => ({ [key]: rule.field, order: rule.order })));
}

function paging(input: CommandInput): Record<string, string | undefined> {
  return {
    limit: input.options.limit === undefined ? undefined : String(input.options.limit),
    next: input.options.next as string | undefined
  };
}

function list(value: unknown): string | undefined {
  const values = value as string[] | undefined;
  return values && values.length > 0 ? values.join(',') : undefined;
}

const LISTING: Pagination = { items: 'data', cursor: 'next' };

/** What the batch count endpoint accepts, and what the design document states. */
const MAX_COUNTED_CONTAINERS = 10;

/**
 * A form's fields arrive as one object per field, keyed by api_code. A list of
 * fields is what a caller asked for, so it is a list here, with the api_code
 * alongside the rest rather than hidden in the key.
 */
function selectFields(body: unknown): Record<string, unknown>[] {
  const fields = (body as { fields?: Record<string, Record<string, unknown>>[] } | undefined)?.fields ?? [];
  return fields.flatMap((entry) =>
    Object.entries(entry).map(([api_code, attributes]) => ({ api_code, ...attributes })));
}

function payload(input: CommandInput): unknown {
  const value = input.options.json;
  if (value === undefined) throw new UsageError('--json <json|@file|-> is required');
  return value;
}

// --- commands --------------------------------------------------------------

const ACCOUNT: readonly Command[] = [
  {
    path: ['account', 'get'],
    summary: 'Show the current account, plan and quota',
    request: () => ({ method: 'GET', path: `${API}/billing_account` })
  },
  {
    path: ['account', 'member', 'list'],
    summary: 'List account members',
    options: [LIMIT_OPTION],
    request: (input) => ({ method: 'GET', path: `${API}/billing_account/users`, query: paging(input) })
  }
];

const FOLDER: readonly Command[] = [
  {
    path: ['folder', 'list'],
    summary: 'List folders',
    options: [LIMIT_OPTION],
    request: (input) => ({ method: 'GET', path: `${API}/folders`, query: paging(input) })
  }
];

const FORM: readonly Command[] = [
  {
    path: ['form', 'list'],
    summary: 'List forms',
    description:
      'Filters act on the form itself: form_name, created_at, last_entry_created_at, entries_count.',
    options: [
      { name: '--name', type: 'string', repeatable: true, placeholder: '<kw>', description: 'Match forms whose name contains the keyword' },
      FILTER_OPTION, FILTERS_OPTION, SORT_OPTION, ...PAGINATION_OPTIONS
    ],
    request: (input) => ({
      method: 'GET',
      path: `${API}/forms`,
      query: { q: list(input.options.name), filters: filters(input), sort: sort(input, 'field'), ...paging(input) }
    }),
    paginate: LISTING,
    examples: ["jinshuju form list --name 报名", "jinshuju form list --sort entries_count:desc --limit 10"]
  },
  {
    path: ['form', 'get'],
    summary: 'Show a form: fields, types, choices',
    args: [{ name: 'form', required: true, description: 'Form token, six letters and digits, e.g. Kp7mQ2' }],
    request: (input) => ({ method: 'GET', path: `${API}/forms/${input.args.form}` }),
    examples: ['jinshuju form get Kp7mQ2']
  },
  {
    path: ['form', 'create'],
    summary: 'Create a form',
    description:
      'Field types use the API v1 names (TextField, MobileField, RadioButton). Do not pass api_code: the backend generates it.',
    options: [JSON_OPTION],
    request: (input) => ({ method: 'POST', path: `${API}/forms`, body: validateCreateFormPayload(payload(input)) }),
    examples: ['jinshuju form create --json @form.json', 'cat form.json | jinshuju form create --json -']
  },
  {
    path: ['form', 'rule', 'get'],
    summary: 'Show the field display rules of a form',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    request: (input) => ({ method: 'GET', path: `${API}/forms/${input.args.form}/field_rules` })
  },
  {
    path: ['form', 'cooperator', 'list'],
    summary: 'List the cooperators of a form',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    request: (input) => ({ method: 'GET', path: `${API}/forms/${input.args.form}/cooperators` })
  }
];

const TABLE: readonly Command[] = [
  {
    path: ['table', 'list'],
    summary: 'List tables',
    options: [
      { name: '--name', type: 'string', repeatable: true, placeholder: '<kw>', description: 'Match tables whose name contains the keyword' },
      FILTER_OPTION, FILTERS_OPTION, SORT_OPTION, ...PAGINATION_OPTIONS
    ],
    request: (input) => ({
      method: 'GET',
      path: `${API}/tables`,
      query: { q: list(input.options.name), filters: filters(input), sort: sort(input, 'field'), ...paging(input) }
    }),
    paginate: LISTING,
    examples: ['jinshuju table list --name 台账', 'jinshuju entry list --table Vn4xR8']
  },
  {
    path: ['table', 'get'],
    summary: 'Show a table: columns, types, choices',
    args: [{ name: 'table', required: true, description: 'Table token, six letters and digits, e.g. Vn4xR8' }],
    request: (input) => ({ method: 'GET', path: `${API}/tables/${input.args.table}` }),
    examples: ['jinshuju table get Vn4xR8']
  }
];

const FIELD: readonly Command[] = [
  {
    path: ['field', 'list'],
    summary: 'List the fields of a form or table',
    description: 'Read out of the object structure, the same fields `form get` and `table get` return.',
    options: [...CONTAINER_OPTIONS],
    request: (input) => ({ method: 'GET', path: containerPath(input) }),
    select: (body) => ({ data: selectFields(body) })
  }
];

const VIEW: readonly Command[] = [
  {
    path: ['view', 'list'],
    summary: 'List the views of a form or table',
    options: [...CONTAINER_OPTIONS],
    request: (input) => ({ method: 'GET', path: `${containerPath(input)}/views` })
  },
  {
    path: ['view', 'get'],
    summary: 'Show a view',
    args: [{ name: 'view', required: true, description: 'View token, six letters and digits, e.g. aB3dE9' }],
    options: [...CONTAINER_OPTIONS],
    request: (input) => ({ method: 'GET', path: `${containerPath(input)}/views/${input.args.view}` })
  }
];

const ENTRY: readonly Command[] = [
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
      FILTER_OPTION, FILTERS_OPTION, SORT_OPTION, ...PAGINATION_OPTIONS
    ],
    request: (input) => {
      const view = input.options.view as string | undefined;
      if (view) {
        for (const flag of ['filter', 'filters', 'keyword', 'sort'] as const) {
          const value = input.options[flag];
          if (Array.isArray(value) ? value.length > 0 : value !== undefined) {
            throw new UsageError(`--${flag} cannot be combined with --view: the view carries its own filter and sort`);
          }
        }
        return { method: 'GET', path: `${containerPath(input)}/views/${view}/entries`, query: paging(input) };
      }
      return {
        method: 'GET',
        path: `${containerPath(input)}/entries`,
        query: {
          filters: filters(input),
          keyword: input.options.keyword as string | undefined,
          fields: list(input.options.fields),
          sort: sort(input, 'api_code'),
          ...paging(input)
        }
      };
    },
    paginate: LISTING,
    examples: [
      'jinshuju entry list --form Kp7mQ2',
      "jinshuju entry list --form Kp7mQ2 --filter 'field_3 gte 80' --sort created_at:desc",
      'jinshuju entry list --form Kp7mQ2 --all'
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
      FILTER_OPTION, FILTERS_OPTION
    ],
    request: (input) => {
      const { tokens, kind } = resolveContainers(input.options, MAX_COUNTED_CONTAINERS);
      const query = { filters: filters(input), keyword: input.options.keyword as string | undefined };
      if (tokens.length === 1) {
        return { method: 'GET', path: `${API}/${kind === 'table' ? 'tables' : 'forms'}/${tokens[0]}/entries/count`, query };
      }
      return { method: 'GET', path: `${API}/entries/count`, query: { ...query, form_tokens: tokens.join(',') } };
    },
    examples: [
      "jinshuju entry count --form Kp7mQ2 --filter 'field_3 gte 80'",
      'jinshuju entry count --form Kp7mQ2 --form Vn4xR8 --form aB3dE9'
    ]
  },
  {
    path: ['entry', 'aggregate'],
    summary: 'Compute statistics over the entries matching a filter',
    description:
      'The response is as big as the metrics and groups asked for, never as big as the data. Which ' +
      'functions a field takes is the field\'s own answer: read analytics.agg_funcs from `form get`.',
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--metric', type: 'string', repeatable: true, placeholder: '<func>:<field>', description: 'Statistic to compute, repeatable, 1 to 20. e.g. avg:field_3' },
      { name: '--by', type: 'string', repeatable: true, placeholder: `<field>[:${TIME_BUCKETS.join('|')}]`, description: 'Group by this field, repeatable, at most 2. A date field needs a bucket' },
      { name: '--limit', type: 'integer', placeholder: '<n>', description: 'How many groups, ranked by the first metric (default 20, max 200)' },
      FILTER_OPTION, FILTERS_OPTION
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
    examples: [
      'jinshuju entry aggregate --form Kp7mQ2 --metric avg:field_3',
      'jinshuju entry aggregate --form Kp7mQ2 --metric count:field_1 --by created_at:month',
      "jinshuju entry aggregate --form Kp7mQ2 --metric sum:field_5 --by field_7 --limit 5 --filter 'created_at within_last 30d'"
    ]
  },
  {
    path: ['entry', 'summary'],
    summary: 'Profile every analysable field at once',
    description:
      'One pass over the data describing each field in its own terms: choices by share, numbers by ' +
      'spread, dates by range. Submission metadata is left out — it describes the submitting, not the answer.',
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--fields', type: 'list', placeholder: '<api-code,...>', description: 'Profile only these fields, at most 60' },
      { name: '--no-overview', type: 'boolean', description: 'Leave out the form-level totals' },
      FILTER_OPTION, FILTERS_OPTION
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
    summary: 'Create one entry',
    description: 'The payload is keyed by field api_code, not by field label.',
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    request: (input) => ({ method: 'POST', path: `${containerPath(input)}/entries`, body: payload(input) }),
    examples: ['jinshuju entry create --form Kp7mQ2 --json \'{"field_1":"张三"}\'']
  },
  {
    path: ['entry', 'get'],
    summary: 'Show one entry',
    args: [{ name: 'serial', required: true, description: 'Entry serial number' }],
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--fields', type: 'list', placeholder: '<api-code,...>', description: 'Return only these fields' }
    ],
    request: (input) => ({
      method: 'GET',
      path: `${containerPath(input)}/entries/${input.args.serial}`,
      query: { fields: list(input.options.fields) }
    })
  }
];

const COMMENT: readonly Command[] = [
  {
    path: ['comment', 'list'],
    summary: "List an entry's comments",
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--entry', type: 'string', placeholder: '<serial>', description: 'Entry serial number' }
    ],
    request: (input) => {
      const serial = input.options.entry as string | undefined;
      if (!serial) throw new UsageError('--entry <serial> is required');
      return { method: 'GET', path: `${containerPath(input)}/entries/${serial}/comments` };
    }
  }
];

const OPENSEARCH: readonly Command[] = [
  {
    path: ['opensearch', 'list'],
    summary: 'List public queries',
    options: [{ name: '--form', type: 'string', placeholder: '<token>', description: 'Only the queries of this form' }],
    request: (input) => ({
      method: 'GET',
      path: `${API}/opensearch/queries`,
      query: { form_token: input.options.form as string | undefined }
    })
  },
  {
    path: ['opensearch', 'get'],
    summary: 'Show a public query',
    args: [{ name: 'query', required: true, description: 'Public query token' }],
    request: (input) => ({ method: 'GET', path: `${API}/opensearch/queries/${input.args.query}` })
  },
  {
    path: ['opensearch', 'fields'],
    summary: 'Suggest the fields a public query can use',
    options: [{ name: '--form', type: 'string', placeholder: '<token>', description: 'Form token' }],
    request: (input) => {
      const form = input.options.form as string | undefined;
      if (!form) throw new UsageError('--form <token> is required');
      return { method: 'GET', path: `${API}/opensearch/query_suggestions`, query: { form_token: form } };
    }
  }
];

export const COMMANDS: readonly Command[] = [
  ...ACCOUNT, ...FOLDER, ...FORM, ...TABLE, ...FIELD, ...VIEW, ...ENTRY, ...COMMENT, ...OPENSEARCH
];

/** The command whose path the words begin with, longest match first. */
export function findCommand(words: readonly string[], commands: readonly Command[] = COMMANDS): Command | undefined {
  let best: Command | undefined;
  for (const command of commands) {
    if (command.path.length > words.length) continue;
    if (command.path.some((part, index) => words[index] !== part)) continue;
    if (!best || command.path.length > best.path.length) best = command;
  }
  return best;
}

export { JSON_OPTION };
