import {
  CONTAINER_OPTIONS,
  FILTER_OPTION,
  FILTERS_OPTION,
  JSON_OPTION,
  SORT_OPTION,
  type OptionSpec
} from '../options.js';
import { YES_OPTION, confirmed, containerPath, filterConditions, overriding, sortRules } from './shared.js';
import type { Command, CommandInput } from './types.js';

/** What `view create` and `view edit` both take, beyond the name. */
const VIEW_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--type',
    type: 'string',
    choices: ['grid', 'kanban', 'stats'],
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
