import { FILTER_OPTION, FILTERS_OPTION, JSON_OPTION, PAGINATION_OPTIONS, SORT_OPTION } from '../options.js';
import { API, FOLDER_OPTION, LISTING, filters, keywords, overriding, paging, payload, sort } from './shared.js';
import type { Command } from './types.js';
import { validateContainerPayload } from '../payload.js';

/**
 * The field types a table column may be, which is a third of what a form takes.
 * Worth naming in the help rather than leaving to a rejected create: the absence
 * of TextField is the one nobody guesses.
 */
const TABLE_FIELD_TYPES = [
  'TextArea',
  'RadioButton',
  'CheckBox',
  'BooleanField',
  'MobileField',
  'NumberField',
  'DateTimeField',
  'EmailField',
  'LinkField',
  'AttachmentField',
  'FormulaField'
] as const;

export const TABLE: readonly Command[] = [
  {
    path: ['table', 'list'],
    summary: 'List tables',
    options: [
      {
        name: '--name',
        type: 'string',
        repeatable: true,
        placeholder: '<kw>',
        description: 'Match tables whose name contains the keyword'
      },
      FILTER_OPTION,
      FILTERS_OPTION,
      SORT_OPTION,
      ...PAGINATION_OPTIONS
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
    description:
      'Column types use the API v1 names, but a table takes fewer of them than a form: ' +
      `${TABLE_FIELD_TYPES.join(', ')}. There is no TextField — a single line of text is a ` +
      'TextArea here. Do not pass api_code: the backend generates it.',
    options: [
      JSON_OPTION,
      FOLDER_OPTION,
      {
        name: '--with-default-entries',
        type: 'boolean',
        description: 'Seed a few blank rows, as the UI does. Leave it off when rows follow'
      }
    ],
    request: (input) => ({
      method: 'POST',
      path: `${API}/tables`,
      body: overriding(validateContainerPayload(payload(input), 'table'), {
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
