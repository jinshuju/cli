import {
  CONTAINER_OPTIONS,
  FILTER_OPTION,
  FILTERS_OPTION,
  JSON_OPTION,
  SORT_OPTION,
  type OptionSpec
} from '../options.js';
import { bodyChoices } from '../spec.js';
import { YES_OPTION, confirmed, filterConditions, onContainer, overriding, sortRules } from './shared.js';
import type { Command, CommandInput } from './types.js';

/** What `view create` and `view edit` both take, beyond the name. */
const VIEW_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--type',
    type: 'string',
    choices: bodyChoices('createFormView', 'view_type'),
    placeholder: '<type>',
    description: 'View type'
  },
  { name: '--columns', type: 'list', placeholder: '<api-code,...>', description: 'Columns to show, in this order' },
  FILTER_OPTION,
  FILTERS_OPTION,
  SORT_OPTION,
  JSON_OPTION
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

export const VIEW: readonly Command[] = [
  {
    path: ['view', 'list'],
    summary: 'List the views of a form or table',
    options: [...CONTAINER_OPTIONS],
    request: (input) => onContainer(input, 'listFormViews', 'listTableViews')
  },
  {
    path: ['view', 'get'],
    summary: 'Show a view',
    args: [{ name: 'view', required: true, description: 'View token, six letters and digits, e.g. aB3dE9' }],
    options: [...CONTAINER_OPTIONS],
    request: (input) => onContainer(input, 'getFormView', 'getTableView', { path: { view_token: input.args.view } })
  },
  {
    path: ['view', 'create'],
    summary: 'Create a view',
    description:
      'A view carries its own filter, sort and columns, so `entry list --view` needs none of them. ' +
      'Anything without a flag of its own — kanban grouping, visibility — goes through --json.',
    args: [{ name: 'name', required: true, description: 'View name' }],
    options: [...CONTAINER_OPTIONS, ...VIEW_OPTIONS],
    request: (input) =>
      onContainer(input, 'createFormView', 'createTableView', { body: { ...viewBody(input), name: input.args.name } }),
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
    request: (input) =>
      onContainer(input, 'updateFormView', 'updateTableView', {
        path: { view_token: input.args.view },
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
      return onContainer(input, 'deleteFormView', 'deleteTableView', { path: { view_token: input.args.view } });
    }
  }
];
