import { LIMIT_OPTION } from '../options.js';
import { bodyChoices, call } from '../spec.js';
import { given, paging } from './shared.js';
import type { Command } from './types.js';

export const FOLDER: readonly Command[] = [
  {
    path: ['folder', 'list'],
    summary: 'List folders',
    options: [LIMIT_OPTION],
    request: (input) => call('listFolders', { query: paging(input) })
  },
  {
    path: ['folder', 'get'],
    summary: 'Show a folder: its name and kind',
    description: 'Takes the folder_token a form or table answers with, to say which folder that is.',
    args: [{ name: 'folder', required: true, description: 'Folder token, e.g. Fd2xK8' }],
    request: (input) => call('getFolder', { path: { folder_token: input.args.folder } }),
    examples: ['jinshuju folder get Fd2xK8']
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
        choices: bodyChoices('createFolder', 'kind'),
        placeholder: '<kind>',
        description: 'What the folder holds (default form)'
      }
    ],
    request: (input) => call('createFolder', { body: given({ name: input.args.name, kind: input.options.kind }) }),
    examples: ['jinshuju folder create 2026年活动', 'jinshuju folder create 台账 --kind table']
  }
];
