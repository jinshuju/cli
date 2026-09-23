import { LIMIT_OPTION } from '../options.js';
import { API, paging } from './shared.js';
import type { Command } from './types.js';

export const FOLDER: readonly Command[] = [
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
      {
        name: '--kind',
        type: 'string',
        choices: ['form', 'table'],
        placeholder: '<kind>',
        description: 'What the folder holds (default form)'
      }
    ],
    request: (input) => ({
      method: 'POST',
      path: `${API}/folders`,
      body: { name: input.args.name, kind: input.options.kind }
    }),
    examples: ['jinshuju folder create 2026年活动', 'jinshuju folder create 台账 --kind table']
  }
];
