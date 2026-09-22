import {
  CONTAINER_LIST_OPTIONS, CONTAINER_OPTIONS, FILTER_OPTION, FILTERS_OPTION, JSON_OPTION, LIMIT_OPTION,
  MINE_OPTION, PAGINATION_OPTIONS, SORT_OPTION, TIME_BUCKETS, UsageError, parseDimension, parseFilter, parseMetric, parseSort,
  resolveContainer, resolveContainers, type FilterCondition, type OptionSpec, type SortRule
} from './options.js';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { validateCreateFormPayload } from './payload.js';
import { progress } from './progress.js';
import type { HttpClient } from './http.js';

/**
 * Every command the CLI has, as data.
 *
 * The shape is `jinshuju <resource> <verb> [args] [flags]`: resources kept at
 * one level, the parent given by a flag —
 * `entry list --form <token>`, not `form entry list <token>`. Help, argument
 * checking and dispatch all read this table, so a command cannot be reachable
 * without its help, nor accept a flag it never described.
 */

export interface ArgSpec {
  readonly name: string;
  readonly required: boolean;
  /** Takes the rest of the words; only the last argument may. */
  readonly variadic?: boolean;
  readonly description: string;
}

/** A repeated parameter arrives as a list; everything else is one value. */
export type QueryValues = Record<string, string | readonly string[] | undefined>;

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: QueryValues;
  readonly body?: unknown;
  /** A multipart body, for the endpoints that take a file. */
  readonly form?: FormData;
}

/** How a listing returns its next page, which is what `--all` follows. */
export interface Pagination {
  readonly items: string;
  readonly cursor: string;
}

export interface CommandInput {
  readonly args: Record<string, string>;
  /** The values of a variadic argument, in the order given. */
  readonly rest: readonly string[];
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
  /**
   * For the commands a single request cannot express: uploading a file and then
   * acting on it. It gets the client and returns whatever should be printed.
   */
  readonly run?: (input: CommandInput, client: HttpClient) => Promise<unknown>;
  readonly paginate?: Pagination;
  /**
   * Narrows the response to what the command is about. `field list` asks for a
   * form because that is where fields live, but a caller asked for the fields.
   */
  readonly select?: (body: unknown) => unknown;
  /**
   * Reshapes the response for reading, and only for reading: `--output json`
   * answers what the API answered. A command needs this when its payload is
   * built for indexing rather than for looking at, and no generic renderer
   * could know how to put it back together.
   */
  readonly render?: (body: unknown) => unknown;
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

/** The conditions themselves. A read sends them as a query string, a write as a body. */
function filterConditions(input: CommandInput): unknown {
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

function filters(input: CommandInput): string | undefined {
  const conditions = filterConditions(input);
  return conditions === undefined ? undefined : JSON.stringify(conditions);
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

/** The sort rules as the API's own objects, for a body. */
function sortRules(input: CommandInput): { api_code: string; order: string }[] | undefined {
  const rules = (input.options.sort as string[] | undefined) ?? [];
  if (rules.length === 0) return undefined;
  return rules.map(parseSort).map((rule: SortRule) => ({ api_code: rule.field, order: rule.order }));
}

/**
 * A delete says so out loud. Nothing here prompts — stdin belongs to `--json -`
 * — so the confirmation is a flag, and leaving it out is the safe outcome
 * rather than a question nobody is there to answer.
 */
function confirmed(input: CommandInput, what: string): void {
  if (!input.options.yes) throw new UsageError(`${what} is permanent; pass --yes to go ahead`);
}

/**
 * Drops the keys an optional flag left undefined. JSON.stringify would drop
 * them on the wire anyway, but a body that carries them reads as though the
 * caller asked for the field to be unset, and shows up that way in --output
 * json and in anything asserting on the request.
 */
function given<T extends Record<string, unknown>>(body: T): Partial<T> {
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
function overriding(payload: Record<string, unknown>, flags: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, ...given(flags) };
}

/** A write that names one thing still sends the API a list of one. */
function one(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

const YES_OPTION: OptionSpec = { name: '--yes', type: 'boolean', description: 'Confirm the deletion' };

const FOLDER_OPTION: OptionSpec = {
  name: '--folder', type: 'string', placeholder: '<token>', description: 'Folder token; empty moves it out of any folder'
};

/**
 * `--mine` is a different range, not a narrower one: it reads what the caller
 * submitted to forms they need not own. The flags that describe the owner-side
 * question have no counterpart there, so naming one alongside --mine is
 * refused rather than quietly dropped.
 */
function refuseWithMine(input: CommandInput, flags: readonly string[]): void {
  for (const flag of flags) {
    const value = input.options[flag];
    const given = Array.isArray(value) ? value.length > 0 : value !== undefined;
    if (given) throw new UsageError(`--${flag.replace(/_/g, '-')} cannot be combined with --mine`);
  }
}

function list(value: unknown): string | undefined {
  const values = value as string[] | undefined;
  return values && values.length > 0 ? values.join(',') : undefined;
}

/**
 * Keywords stay separate: the API matches a name containing any of them, and
 * joining them would ask for one keyword with a comma in it.
 */
function keywords(value: unknown): readonly string[] | undefined {
  const values = value as string[] | undefined;
  return values && values.length > 0 ? values : undefined;
}

function labels(input: CommandInput): string | undefined {
  return input.options.labels ? 'true' : undefined;
}

const LABELS_OPTION: OptionSpec = {
  name: '--labels',
  type: 'boolean',
  description: "Pair each value with its field's label, saving a second read of the form"
};

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
  },
  {
    path: ['folder', 'create'],
    summary: 'Create a folder',
    description: 'A folder holds one kind. A table refuses a form folder, so say which when it is not forms.',
    args: [{ name: 'name', required: true, description: 'Folder name' }],
    options: [
      { name: '--kind', type: 'string', choices: ['form', 'table'], placeholder: '<kind>', description: 'What the folder holds (default form)' }
    ],
    request: (input) => ({
      method: 'POST',
      path: `${API}/folders`,
      body: { name: input.args.name, kind: input.options.kind }
    }),
    examples: ['jinshuju folder create 2026年活动', 'jinshuju folder create 台账 --kind table']
  }
];

/**
 * What `form get --include` accepts, and the parameter each one asks for. The
 * names are the CLI's — short, and about the thing rather than about the flag
 * that fetches it.
 */
const FORM_INCLUDES: Record<string, string> = {
  // `setting` is in the design and already part of the payload, so asking for
  // it is honoured by there being nothing to fetch. It is listed so the help
  // matches what the flag accepts.
  setting: '',
  theme: 'include_theme',
  rules: 'include_field_rules',
  extended: 'include_extended_attributes',
  transactions: 'include_transactions',
  analytics: 'include_analytics'
};

const INCLUDE_OPTION: OptionSpec = {
  name: '--include',
  type: 'list',
  placeholder: Object.keys(FORM_INCLUDES).join(','),
  description: `Extra blocks to carry: ${Object.keys(FORM_INCLUDES).join(', ')}. The setting is always there`
};

function includes(input: CommandInput): Record<string, string | undefined> {
  const asked = (input.options.include as string[] | undefined) ?? [];
  const query: Record<string, string | undefined> = {};
  for (const name of asked) {
    const parameter = FORM_INCLUDES[name];
    if (parameter === '') continue;
    if (!parameter) {
      throw new UsageError(`--include takes ${Object.keys(FORM_INCLUDES).join(', ')}, got ${JSON.stringify(name)}`);
    }
    query[parameter] = 'true';
  }
  return query;
}

function themeBody(input: CommandInput): Record<string, unknown> {
  const rest = (input.options.json as Record<string, unknown> | undefined) ?? {};
  return overriding(rest, {
    primary_color: input.options.primary_color,
    secondary_color: input.options.secondary_color
  });
}

async function uploadImage(client: HttpClient, file: string, imageType: string): Promise<string> {
  const watching = progress();
  watching.step(`uploading ${basename(file)}…`);
  try {
  const uploaded = await client.request<{ attachment_id: string }>(
    upload(`${API}/form_image_attachments`, file, { image_type: imageType })
  );
  return uploaded.attachment_id;
  } finally {
    watching.done();
  }
}

/** The scenes a form can be created for, as the API names them. */
const FORM_SCENES = ['survey', 'registry', 'vote', 'exam', 'reservation',
  'customer_acquisition', 'evaluation', 'online_payment'] as const;

/**
 * A form's type picks both the scene it is created in and the settings block
 * that belongs to it. Those settings live behind their own endpoint, so a
 * payload carrying one is two requests, not one — and a generic edit would
 * drop the block on the floor, since the form update only reads name,
 * description, setting, fields and field_rules.
 */
const FORM_TYPES: Record<string, { scene?: string; settingKey?: string; path?: string }> = {
  normal: {},
  exam: { scene: 'exam', settingKey: 'exam_setting', path: 'exam_setting' },
  evaluation: { scene: 'evaluation', settingKey: 'evaluation_setting', path: 'evaluation_setting' }
};

/** Which settings block a payload carries, and where it has to be sent. */
function settingsBlock(body: Record<string, unknown>): { key: string; path: string; value: unknown } | undefined {
  for (const { settingKey, path } of Object.values(FORM_TYPES)) {
    if (settingKey && path && body[settingKey] !== undefined) {
      return { key: settingKey, path, value: body[settingKey] };
    }
  }
  return undefined;
}

/** The scene a --type implies, refusing a --scene that contradicts it. */
function sceneFor(input: CommandInput): string | undefined {
  const type = (input.options.type as string | undefined) ?? 'normal';
  const scene = input.options.scene as string | undefined;
  const implied = FORM_TYPES[type]?.scene;
  if (implied && scene && scene !== implied) {
    throw new UsageError(`--type ${type} is the ${implied} scene, so --scene ${scene} contradicts it`);
  }
  return implied ?? scene;
}

function createFormBody(input: CommandInput): { body: Record<string, unknown>; settings?: { key: string; path: string; value: unknown } } {
  const payloadBody = { ...(validateCreateFormPayload(payload(input)) as Record<string, unknown>) };
  const settings = settingsBlock(payloadBody);
  if (settings) delete payloadBody[settings.key];

  return {
    body: overriding(payloadBody, {
      scene: sceneFor(input),
      layout: input.options.layout,
      folder_token: input.options.folder
    }),
    settings
  };
}

const FORM: readonly Command[] = [
  {
    path: ['form', 'list'],
    summary: 'List forms',
    description:
      'Filters act on the form itself: form_name, created_at, last_entry_created_at, entries_count.',
    options: [
      { name: '--name', type: 'string', repeatable: true, placeholder: '<kw>', description: 'Match forms whose name contains the keyword, repeatable' },
      { name: '--with-transactions', type: 'boolean', description: "Carry each payment form's collected totals" },
      MINE_OPTION,
      FILTER_OPTION, FILTERS_OPTION, SORT_OPTION, ...PAGINATION_OPTIONS
    ],
    request: (input) => {
      if (input.options.mine) {
        refuseWithMine(input, ['name', 'with_transactions', 'filter', 'filters', 'sort']);
        return { method: 'GET', path: `${API}/my/forms`, query: paging(input) };
      }
      return {
      method: 'GET',
      path: `${API}/forms`,
      query: {
        q: keywords(input.options.name),
        include_transactions: input.options.with_transactions ? 'true' : undefined,
        filters: filters(input),
        sort: sort(input, 'field'),
        ...paging(input)
      }
      };
    },
    paginate: LISTING,
    examples: [
      "jinshuju form list --name 报名",
      'jinshuju form list --sort entries_count:desc --limit 10',
      'jinshuju form list --mine'
    ]
  },
  {
    path: ['form', 'get'],
    summary: 'Show a form: fields, types, choices',
    description:
      'The form carries its setting already. --include adds the blocks that are separate reads ' +
      'otherwise, so asking for a form and its rules is one round trip. analytics says which ' +
      'statistics each field takes, which is what the analysis reads validate against.',
    args: [{ name: 'form', required: true, description: 'Form token, six letters and digits, e.g. Kp7mQ2' }],
    options: [INCLUDE_OPTION],
    request: (input) => ({
      method: 'GET',
      path: `${API}/forms/${input.args.form}`,
      query: includes(input)
    }),
    examples: ['jinshuju form get Kp7mQ2', 'jinshuju form get Kp7mQ2 --include theme,rules,analytics']
  },
  {
    path: ['form', 'create'],
    summary: 'Create a form',
    description:
      'Field types use the API v1 names (TextField, MobileField, RadioButton). Do not pass api_code: ' +
      'the backend generates it. The scene decides what kind of form it is — an exam scores its ' +
      'answers, a reservation holds slots — and the card layout refuses the field types it cannot show.',
    options: [
      JSON_OPTION,
      { name: '--type', type: 'string', choices: Object.keys(FORM_TYPES), placeholder: '<type>', description: 'normal, exam or evaluation. An exam or evaluation also takes its own settings block in the payload' },
      { name: '--scene', type: 'string', choices: FORM_SCENES, placeholder: '<scene>', description: `What the form is for: ${FORM_SCENES.join(', ')}` },
      { name: '--layout', type: 'string', choices: ['classic', 'card'], placeholder: '<layout>', description: 'classic shows every field at once, card one page at a time' },
      FOLDER_OPTION
    ],
    request: (input) => ({
      method: 'POST',
      path: `${API}/forms`,
      body: createFormBody(input).body
    }),
    run: async (input, client) => {
      const { body, settings } = createFormBody(input);
      if (!settings) return undefined;

      const form = await client.request<{ token: string }>({ method: 'POST', path: `${API}/forms`, body });
      try {
        await client.request({ method: 'PATCH', path: `${API}/forms/${form.token}/${settings.path}`, body: settings.value });
      } catch (error) {
        // The form exists; saying so beats an error that reads as though
        // nothing happened and inviting a second one to be created.
        throw new Error(`form ${form.token} was created, but its ${settings.key} was refused: ` +
          `${(error as Error).message}. Fix it and apply with \`form edit\`.`);
      }
      return client.request({ method: 'GET', path: `${API}/forms/${form.token}` });
    },
    examples: [
      'jinshuju form create --json @form.json',
      'jinshuju form create --json @exam.json --type exam',
      'cat form.json | jinshuju form create --json -'
    ]
  },
  {
    path: ['form', 'edit'],
    summary: 'Edit a form',
    description:
      'The payload carries the operations to apply: name, description, setting, and fields as ' +
      '{add, update, update_choices, remove}. Only what is named changes.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [JSON_OPTION],
    request: (input) => ({ method: 'PATCH', path: `${API}/forms/${input.args.form}`, body: payload(input) }),
    run: async (input, client) => {
      const body = { ...(payload(input) as Record<string, unknown>) };
      const settings = settingsBlock(body);
      if (!settings) return undefined;

      delete body[settings.key];
      // The settings go first: they are the half that can be refused for what
      // the form is, and a refusal that has already renamed the form would
      // leave the edit half applied.
      await client.request({ method: 'PATCH', path: `${API}/forms/${input.args.form}/${settings.path}`, body: settings.value });
      if (Object.keys(body).length === 0) return client.request({ method: 'GET', path: `${API}/forms/${input.args.form}` });

      return client.request({ method: 'PATCH', path: `${API}/forms/${input.args.form}`, body });
    },
    examples: [
      'jinshuju form edit Kp7mQ2 --json \'{"name":"2026 活动报名"}\'',
      'jinshuju form edit Kp7mQ2 --json \'{"exam_setting":{"total_score":100}}\''
    ]
  },
  {
    path: ['form', 'copy'],
    summary: 'Copy a form',
    args: [{ name: 'form', required: true, description: 'Form token to copy' }],
    options: [
      { name: '--name', type: 'string', placeholder: '<name>', description: 'Name for the copy' },
      FOLDER_OPTION
    ],
    request: (input) => ({
      method: 'POST',
      path: `${API}/forms/${input.args.form}/copy`,
      body: given({ name: input.options.name, folder_token: input.options.folder })
    })
  },
  {
    path: ['form', 'move'],
    summary: 'Move a form into a folder, or out of one',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [FOLDER_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: `${API}/forms/${input.args.form}/folder`,
      body: { folder_token: (input.options.folder as string | undefined) ?? '' }
    }),
    examples: ['jinshuju form move Kp7mQ2 --folder Fd2xK8', 'jinshuju form move Kp7mQ2']
  },
  {
    path: ['form', 'theme', 'set'],
    summary: "Set a form's theme",
    description:
      'The colours have flags of their own; everything else the theme takes — typography, ' +
      'form_container, submit_button — goes through --json. Images are not settable yet: uploading ' +
      'one needs a ticket the REST API has no way to issue.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [
      { name: '--primary-color', type: 'string', placeholder: '<hex>', description: 'Primary colour, e.g. #1F6FEB' },
      { name: '--secondary-color', type: 'string', placeholder: '<hex>', description: 'Secondary colour' },
      { name: '--wallpaper', type: 'string', placeholder: '<file>', description: 'Image file to use as the background' },
      { name: '--header', type: 'string', placeholder: '<file>', description: 'Image file to use as the header' },
      JSON_OPTION
    ],
    request: (input) => ({ method: 'PATCH', path: `${API}/forms/${input.args.form}/theme`, body: themeBody(input) }),
    run: async (input, client) => {
      const wallpaper = input.options.wallpaper as string | undefined;
      const header = input.options.header as string | undefined;
      if (!wallpaper && !header) return undefined;

      const body = themeBody(input) as Record<string, Record<string, unknown>>;
      if (wallpaper) {
        const image = await uploadImage(client, wallpaper, 'wallpaper');
        body.wallpaper = { ...(body.wallpaper ?? {}), background_image_attachment_id: image };
      }
      if (header) {
        const image = await uploadImage(client, header, 'header');
        body.header = { ...(body.header ?? {}), header_image_attachment_id: image };
      }
      return client.request({ method: 'PATCH', path: `${API}/forms/${input.args.form}/theme`, body });
    },
    examples: [
      'jinshuju form theme set Kp7mQ2 --primary-color "#1F6FEB"',
      'jinshuju form theme set Kp7mQ2 --wallpaper ./bg.png'
    ]
  },
  {
    path: ['form', 'rule', 'get'],
    summary: 'Show the field display rules of a form',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    request: (input) => ({ method: 'GET', path: `${API}/forms/${input.args.form}/field_rules` })
  },
  {
    path: ['form', 'rule', 'edit'],
    summary: 'Edit the field display rules of a form',
    description: 'The payload is {add, update, remove}; a rule is targeted by the index `form rule get` shows.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [JSON_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: `${API}/forms/${input.args.form}`,
      body: { field_rules: payload(input) }
    })
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
      query: { q: keywords(input.options.name), filters: filters(input), sort: sort(input, 'field'), ...paging(input) }
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
  },
  {
    path: ['table', 'create'],
    summary: 'Create a table',
    description: 'Column types use the API v1 names. Do not pass api_code: the backend generates it.',
    options: [
      JSON_OPTION, FOLDER_OPTION,
      { name: '--with-default-entries', type: 'boolean', description: 'Seed a few blank rows, as the UI does. Leave it off when rows follow' }
    ],
    request: (input) => ({
      method: 'POST',
      path: `${API}/tables`,
      body: overriding(payload(input) as Record<string, unknown>, {
        folder_token: input.options.folder,
        with_default_entries: input.options.with_default_entries ? true : undefined
      })
    }),
    examples: ['jinshuju table create --json @table.json']
  },
  {
    path: ['table', 'move'],
    summary: 'Move a table into a folder, or out of one',
    description: 'The folder must be a table folder; a form folder cannot hold a table.',
    args: [{ name: 'table', required: true, description: 'Table token' }],
    options: [FOLDER_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: `${API}/tables/${input.args.table}/folder`,
      body: { folder_token: (input.options.folder as string | undefined) ?? '' }
    }),
    examples: ['jinshuju table move Vn4xR8 --folder Nf7mDC', 'jinshuju table move Vn4xR8']
  },
  {
    path: ['table', 'edit'],
    summary: 'Edit a table',
    description:
      'The payload carries the operations to apply: name, description, setting, and columns as ' +
      'fields: {add, update, update_choices, remove}.',
    args: [{ name: 'table', required: true, description: 'Table token' }],
    options: [JSON_OPTION],
    request: (input) => ({ method: 'PATCH', path: `${API}/tables/${input.args.table}`, body: payload(input) })
  }
];

/** `field_7:choice_1` into the target the check endpoint reads. */
function parseCheckTarget(target: string): Record<string, unknown> {
  const [field_api_code, choice_value] = target.split(':');
  if (!field_api_code) throw new UsageError(`a check target must be '<api-code>[:<choice>]', got ${JSON.stringify(target)}`);
  return choice_value === undefined ? { field_api_code } : { field_api_code, choice_value };
}

/**
 * The targets a batch check asks about: the plain ones as arguments, and the
 * shapes the argument grammar cannot reach through --json. Both at once is
 * allowed — one edit's targets belong in one call, whatever shape each is.
 */
function checks(input: CommandInput, parse: (target: string) => Record<string, unknown>): unknown[] {
  const fromArgs = input.rest.map(parse);
  const fromJson = input.options.json === undefined ? [] : one(input.options.json);
  const all = [...fromArgs, ...fromJson];
  if (all.length === 0) throw new UsageError('name at least one target, as an argument or through --json');
  return all;
}

function requiredOption(input: CommandInput, key: string): string {
  const value = input.options[key] as string | undefined;
  if (!value) throw new UsageError(`--${key.replace(/_/g, '-')} is required`);
  return value;
}

const FIELD: readonly Command[] = [
  {
    path: ['field', 'list'],
    summary: 'List the fields of a form or table',
    description: 'Read out of the object structure, the same fields `form get` and `table get` return.',
    options: [...CONTAINER_OPTIONS],
    request: (input) => ({ method: 'GET', path: containerPath(input) }),
    select: (body) => ({ data: selectFields(body) })
  },
  {
    path: ['field', 'add'],
    summary: 'Add fields to a form or table',
    description: 'One field object, or a list of them. Do not pass api_code: the backend generates it.',
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: containerPath(input),
      body: { fields: { add: one(payload(input)) } }
    }),
    examples: ['jinshuju field add --form Kp7mQ2 --json \'{"type":"TextField","label":"备注"}\'']
  },
  {
    path: ['field', 'update'],
    summary: 'Update one field',
    description: 'The patch is merged onto the field; the api_code comes from the argument, not the payload.',
    args: [{ name: 'api-code', required: true, description: 'Field api_code, e.g. field_3' }],
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: containerPath(input),
      body: { fields: { update: [{ ...(payload(input) as Record<string, unknown>), api_code: input.args['api-code'] }] } }
    }),
    examples: ['jinshuju field update --form Kp7mQ2 field_3 --json \'{"required":true}\'']
  },
  {
    path: ['field', 'update-choices'],
    summary: "Change a field's choices",
    description: 'The payload is the choice operations the field takes, e.g. {add, update, remove}.',
    args: [{ name: 'api-code', required: true, description: 'Field api_code' }],
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: containerPath(input),
      body: {
        fields: {
          update_choices: [{ ...(payload(input) as Record<string, unknown>), field_api_code: input.args['api-code'] }]
        }
      }
    })
  },
  {
    path: ['field', 'check'],
    summary: 'Ask whether fields or choices already hold data',
    description:
      'The question to ask before removing one: removing a field or choice that still holds ' +
      'entries deletes those entries with it. Name a choice with <api-code>:<choice>. A shape ' +
      'this cannot express — a matrix statement, a cascade level — goes through --json.',
    args: [{ name: 'target', required: false, variadic: true, description: 'field api_code, or api_code:choice' }],
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    request: (input) => ({
      method: 'GET',
      path: `${containerPath(input)}/fields/check`,
      query: { checks: JSON.stringify(checks(input, parseCheckTarget)) }
    }),
    examples: [
      'jinshuju field check --form Kp7mQ2 field_3 field_9',
      'jinshuju field check --form Kp7mQ2 field_7:choice_1'
    ]
  },
  {
    path: ['field', 'preview-convert'],
    summary: 'Preview what changing a field\'s type would do to its data',
    description:
      'The conversion happens in place, so the only thing at stake is the data: this reports how ' +
      'many values are kept and how many are cleared. supported=false means the edit would refuse it.',
    args: [{ name: 'api-code', required: true, description: 'Field api_code' }],
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--to', type: 'string', placeholder: '<type>', description: 'Target field type, e.g. RadioButton' },
      { name: '--precision', type: 'string', placeholder: '<precision>', description: 'For a DateTimeField target, the precision the edit will use' },
      JSON_OPTION
    ],
    request: (input) => {
      const inline = input.options.json === undefined
        ? [{
            field_api_code: input.args['api-code'],
            target_type: requiredOption(input, 'to'),
            target_precision: input.options.precision
          }]
        : one(input.options.json);
      return {
        method: 'GET',
        path: `${containerPath(input)}/fields/preview_convert`,
        query: { checks: JSON.stringify(inline) }
      };
    },
    examples: ['jinshuju field preview-convert --form Kp7mQ2 field_1 --to RadioButton']
  },
  {
    path: ['field', 'remove'],
    summary: 'Remove a field',
    description:
      'Removing a field that still holds answers deletes those answers with it, and cannot be undone.',
    args: [{ name: 'api-code', required: true, description: 'Field api_code' }],
    options: [...CONTAINER_OPTIONS, YES_OPTION],
    request: (input) => {
      confirmed(input, `Removing ${input.args['api-code']} and any answers it holds`);
      return { method: 'PATCH', path: containerPath(input), body: { fields: { remove: [input.args['api-code']] } } };
    },
    examples: ['jinshuju field remove --form Kp7mQ2 field_9 --yes']
  }
];

/** What `view create` and `view edit` both take, beyond the name. */
const VIEW_OPTIONS: readonly OptionSpec[] = [
  { name: '--type', type: 'string', choices: ['grid', 'kanban', 'stats'], placeholder: '<type>', description: 'View type' },
  { name: '--columns', type: 'list', placeholder: '<api-code,...>', description: 'Columns to show, in this order' },
  FILTER_OPTION, FILTERS_OPTION, SORT_OPTION, JSON_OPTION
];

function viewBody(input: CommandInput): Record<string, unknown> {
  const rest = (input.options.json as Record<string, unknown> | undefined) ?? {};
  return overriding(rest, {
    view_type: input.options.type,
    prefer_columns: input.options.columns,
    sort: sortRules(input),
    filter: filterConditions(input)
  });
}

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
  },
  {
    path: ['view', 'create'],
    summary: 'Create a view',
    description:
      'A view carries its own filter, sort and columns, so `entry list --view` needs none of them. ' +
      'Anything without a flag of its own — kanban grouping, visibility — goes through --json.',
    args: [{ name: 'name', required: true, description: 'View name' }],
    options: [...CONTAINER_OPTIONS, ...VIEW_OPTIONS],
    request: (input) => ({
      method: 'POST',
      path: `${containerPath(input)}/views`,
      body: { ...viewBody(input), name: input.args.name }
    }),
    examples: ["jinshuju view create --form Kp7mQ2 高分 --filter 'field_3 gte 80' --sort created_at:desc"]
  },
  {
    path: ['view', 'edit'],
    summary: 'Edit a view',
    description: 'Only what is named changes; --name renames it.',
    args: [{ name: 'view', required: true, description: 'View token' }],
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--name', type: 'string', placeholder: '<name>', description: 'Rename the view' },
      ...VIEW_OPTIONS
    ],
    request: (input) => ({
      method: 'PATCH',
      path: `${containerPath(input)}/views/${input.args.view}`,
      body: overriding(viewBody(input), { name: input.options.name })
    })
  },
  {
    path: ['view', 'delete'],
    summary: 'Delete a view',
    args: [{ name: 'view', required: true, description: 'View token' }],
    options: [...CONTAINER_OPTIONS, YES_OPTION],
    request: (input) => {
      confirmed(input, `Deleting view ${input.args.view}`);
      return { method: 'DELETE', path: `${containerPath(input)}/views/${input.args.view}` };
    }
  }
];

// --- uploads ----------------------------------------------------------------

/**
 * A file on disk, as multipart. The three endpoints that take one authenticate
 * like every other request, so there is no ticket to fetch first: the file goes
 * up in one call and comes back with an id to refer to it by.
 */
function upload(path: string, file: string, extra: Record<string, string> = {}): HttpRequest {
  const form = new FormData();
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new UsageError(`could not read ${file}: ${(error as Error).message}`);
  }
  form.append('file', new Blob([new Uint8Array(bytes)]), basename(file));
  for (const [name, value] of Object.entries(extra)) form.append(name, value);
  return { method: 'POST', path, form };
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

/** `field_5=/path/a.png`, or `field_5.sub_1=/path/a.png` for a table column. */
function parseAttachment(input: string): { field: string; dimension?: string; file: string } {
  const at = input.indexOf('=');
  if (at <= 0) throw new UsageError(`--attach must be '<api-code>[.<sub>]=<file>', got ${JSON.stringify(input)}`);
  const [field, dimension] = input.slice(0, at).split('.');
  const file = input.slice(at + 1);
  if (!field || !file) throw new UsageError(`--attach must be '<api-code>[.<sub>]=<file>', got ${JSON.stringify(input)}`);
  return dimension === undefined ? { field, file } : { field, dimension, file };
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
 * Waits for the rows to be written. A failed import exits non-zero, because
 * the alternative — answering 0 for an import that wrote nothing — is how a
 * caller comes to believe data is there when it is not.
 */
async function awaitImport(client: HttpClient, token: string, jobId: string, watching: { step(m: string): void }): Promise<ImportJob> {
  for (;;) {
    const job = await client.request<ImportJob>({
      method: 'GET', path: `${API}/forms/${token}/entry_imports/${jobId}`
    });
    if (IMPORT_SETTLED.has(job.status)) {
      if (job.status !== 'success') {
        throw new Error(`import ${job.status}${job.error_message ? `: ${job.error_message}` : ''}`);
      }
      return job;
    }
    const seen = job.processed_rows ?? 0;
    const total = job.total_rows;
    watching.step(`importing ${seen}${total ? `/${total}` : ''} rows…`);
    await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_MS));
  }
}

const BATCH_OPTION: OptionSpec = {
  name: '--batch', type: 'json', placeholder: '<json|@file|->', description: 'Several rows in one request'
};

function attachments(input: CommandInput): { field: string; dimension?: string; file: string }[] {
  return ((input.options.attach as string[] | undefined) ?? []).map(parseAttachment);
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
      LABELS_OPTION, MINE_OPTION, FILTER_OPTION, FILTERS_OPTION, SORT_OPTION, ...PAGINATION_OPTIONS
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
      const containers = (input.options.form as string[] | undefined) ?? [];
      const tables = (input.options.table as string[] | undefined) ?? [];
      if (containers.length > 0 && tables.length > 0) {
        throw new UsageError('--form and --table are mutually exclusive');
      }
      const tokens = containers.length > 0 ? containers : tables;
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
      { name: '--to', type: 'string', placeholder: '<YYYY-MM-DD>', description: 'Last day to count, inclusive. Defaults to today' },
      { name: '--kind', type: 'string', choices: ['form', 'table'], placeholder: '<kind>', description: 'Count only forms, or only tables' },
      { name: '--limit', type: 'integer', placeholder: '<n>', description: 'How many forms to list, most submissions first (default 100, max 100)' }
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
    summary: 'Create entries',
    description:
      'The payload is keyed by field api_code, not by field label. --batch takes a list of them and ' +
      'writes them in one request.',
    options: [
      ...CONTAINER_OPTIONS, JSON_OPTION, BATCH_OPTION,
      { name: '--attach', type: 'string', repeatable: true, placeholder: '<api-code>[.<sub>]=<file>', description: 'Upload a file and fill this attachment field with it, repeatable' }
    ],
    request: (input) => {
      const batch = batchRows(input);
      if (batch) return { method: 'POST', path: batchPath(input), body: { entries: batch } };
      return { method: 'POST', path: `${containerPath(input)}/entries`, body: payload(input) };
    },
    run: async (input, client) => {
      const attached = attachments(input);
      if (attached.length === 0) return undefined;
      if (input.options.batch !== undefined) throw new UsageError('--attach cannot be combined with --batch');

      const container = containerPath(input);
      const { token } = resolveContainer(input.options);
      const body = { ...((input.options.json as Record<string, unknown> | undefined) ?? {}) };
      const watching = progress();
      try {
      for (const { field, dimension, file } of attached) {
        watching.step(`uploading ${basename(file)}…`);
        const uploaded = await client.request<{ id: string }>(
          upload(`${API}/forms/${token}/entry_attachments`, file,
            dimension === undefined ? { field_api_code: field } : { field_api_code: field, dimension_api_code: dimension })
        );
        // A field holds a list of attachments, so each upload appends rather
        // than replacing what an earlier --attach for the same field put there.
        const key = dimension === undefined ? field : `${field}.${dimension}`;
        const existing = body[key];
        body[key] = Array.isArray(existing) ? [...existing, uploaded.id] : [uploaded.id];
      }
      return await client.request({ method: 'POST', path: `${container}/entries`, body });
      } finally {
        watching.done();
      }
    },
    examples: [
      'jinshuju entry create --form Kp7mQ2 --json \'{"field_1":"张三"}\'',
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
      ...CONTAINER_OPTIONS, JSON_OPTION, BATCH_OPTION,
      { name: '--replace', type: 'boolean', description: 'Write the entry as given, clearing fields the payload leaves out' }
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
      'and the message names the sheet\'s real layout. Once accepted the rows are written in the ' +
      'background: the answer means started, not finished.',
    args: [{ name: 'file', required: true, description: 'Path to an .xlsx, .xls or .csv file' }],
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--map', type: 'string', repeatable: true, placeholder: '<api-code>=<column>', description: 'Which column feeds which field. A number is a column index, anything else a header label' },
      { name: '--header-row', type: 'integer', placeholder: '<n>', description: 'Which row holds the headers, when it is not the first' },
      { name: '--unique', type: 'string', placeholder: '<api-code>', description: 'Treat this field as the key: a row matching an existing one updates it' },
      { name: '--wait', type: 'boolean', description: 'Wait for the rows to be written and report what the import did, failing if it failed' }
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

/** A comment lives under its entry, so every verb needs the entry as well. */
const ENTRY_OPTION: OptionSpec = {
  name: '--entry', type: 'string', placeholder: '<serial>', description: 'Entry serial number'
};

function commentsPath(input: CommandInput): string {
  const serial = input.options.entry as string | undefined;
  if (!serial) throw new UsageError('--entry <serial> is required');
  return `${containerPath(input)}/entries/${serial}/comments`;
}

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
  },
  {
    path: ['comment', 'create'],
    summary: 'Comment on an entry',
    args: [{ name: 'content', required: true, description: 'Comment text' }],
    options: [
      ...CONTAINER_OPTIONS, ENTRY_OPTION,
      { name: '--reply-to', type: 'string', placeholder: '<comment-id>', description: 'Reply under this comment' }
    ],
    request: (input) => ({
      method: 'POST',
      path: `${commentsPath(input)}`,
      body: given({ content: input.args.content, parent_id: input.options.reply_to })
    }),
    examples: ['jinshuju comment create --form Kp7mQ2 --entry 12 "已联系，等回复"']
  },
  {
    path: ['comment', 'update'],
    summary: 'Edit a comment',
    args: [
      { name: 'comment', required: true, description: 'Comment id' },
      { name: 'content', required: true, description: 'New comment text' }
    ],
    options: [...CONTAINER_OPTIONS, ENTRY_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: `${commentsPath(input)}/${input.args.comment}`,
      body: { content: input.args.content }
    })
  },
  {
    path: ['comment', 'delete'],
    summary: 'Delete a comment',
    args: [{ name: 'comment', required: true, description: 'Comment id' }],
    options: [...CONTAINER_OPTIONS, ENTRY_OPTION, YES_OPTION],
    request: (input) => {
      confirmed(input, `Deleting comment ${input.args.comment}`);
      return { method: 'DELETE', path: `${commentsPath(input)}/${input.args.comment}` };
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
  },
  {
    path: ['opensearch', 'create'],
    summary: 'Create a public query',
    description: 'Ask `opensearch fields --form <token>` which fields a query may search on and return.',
    options: [
      { name: '--form', type: 'string', placeholder: '<token>', description: 'Form the query reads' },
      JSON_OPTION
    ],
    request: (input) => {
      const form = input.options.form as string | undefined;
      if (!form) throw new UsageError('--form <token> is required');
      return {
        method: 'POST',
        path: `${API}/opensearch/queries`,
        body: overriding(payload(input) as Record<string, unknown>, { form_token: form })
      };
    }
  },
  {
    path: ['opensearch', 'edit'],
    summary: 'Edit a public query, or turn it on and off',
    args: [{ name: 'query', required: true, description: 'Public query token' }],
    options: [
      JSON_OPTION,
      { name: '--enable', type: 'boolean', description: 'Turn the query on' },
      { name: '--disable', type: 'boolean', description: 'Turn the query off' }
    ],
    request: (input) => {
      if (input.options.enable && input.options.disable) {
        throw new UsageError('--enable and --disable are opposites, pass one');
      }
      const rest = (input.options.json as Record<string, unknown> | undefined) ?? {};
      const enabled = input.options.enable ? true : input.options.disable ? false : undefined;
      return {
        method: 'PATCH',
        path: `${API}/opensearch/queries/${input.args.query}`,
        body: overriding(rest, { enabled })
      };
    },
    examples: ['jinshuju opensearch edit Qy7nR3 --disable']
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
