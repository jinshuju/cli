/**
 * Every command the CLI has, as data.
 *
 * The shape is `jinshuju <resource> <verb> [args] [flags]`: resources kept at
 * one level, the parent given by a flag —
 * `entry list --form <token>`, not `form entry list <token>`. Help, argument
 * checking and dispatch all read this table, so a command cannot be reachable
 * without its help, nor accept a flag it never described.
 */

import { ACCOUNT } from './account.js';
import { COMMENT } from './comment.js';
import { ENTRY } from './entry.js';
import { FIELD } from './field.js';
import { FOLDER } from './folder.js';
import { FORM } from './form.js';
import { LOCAL } from './local.js';
import { OPENSEARCH } from './opensearch.js';
import { TABLE } from './table.js';
import type { Command, Resource } from './types.js';
import { VIEW } from './view.js';

export type { ArgSpec, Command, CommandInput, Pagination, Resource } from './types.js';

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

export const COMMANDS: readonly Command[] = [
  ...LOCAL,
  ...ACCOUNT,
  ...FOLDER,
  ...FORM,
  ...TABLE,
  ...FIELD,
  ...VIEW,
  ...ENTRY,
  ...COMMENT,
  ...OPENSEARCH
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
