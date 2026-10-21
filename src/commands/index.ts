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
import { CHECKIN } from './checkin.js';
import { COMMENT } from './comment.js';
import { ENTRY } from './entry.js';
import { FIELD } from './field.js';
import { FILL } from './fill.js';
import { FOLDER } from './folder.js';
import { FORM } from './form.js';
import { LOCAL } from './local.js';
import { OPENSEARCH } from './opensearch.js';
import { ROUTINE } from './routine.js';
import { SMS } from './sms.js';
import { TABLE } from './table.js';
import { TRADE } from './trade.js';
import type { Command, Resource } from './types.js';
import { VIEW } from './view.js';

export type { ArgSpec, Command, CommandInput, Pagination, Resource } from './types.js';

/** Resource order in the root help, and the one-liner each gets. */
export const RESOURCES: readonly Resource[] = [
  {
    name: 'auth',
    summary: 'Manage authentication',
    note:
      'login is the browser flow. To use a token instead: `jinshuju auth login --access-token <token>`, ' +
      'or set JINSHUJU_ACCESS_TOKEN. `auth status --verify` says which account the credential belongs to.'
  },
  { name: 'account', summary: 'Account, members, invoices and what the account paid' },
  { name: 'folder', summary: 'Manage folders' },
  {
    name: 'form',
    summary: 'Manage forms',
    note:
      'There is no delete, on purpose: removing a form takes its entries with it, so it is ' +
      'left to the web app, where the person doing it can see what they are about to lose.'
  },
  { name: 'table', summary: 'Manage tables' },
  { name: 'field', summary: 'Manage fields' },
  { name: 'view', summary: 'Manage views' },
  { name: 'entry', summary: 'Manage entries' },
  { name: 'comment', summary: 'Manage entry comments' },
  { name: 'opensearch', summary: 'Manage public queries' },
  {
    name: 'routine',
    summary: 'Manage routines (自动任务): Jiri at work on a schedule or when data changes',
    note:
      'Routines are your own: an account access token cannot manage them. An OAuth session needs the routines ' +
      'scope, which `jinshuju auth login` asks for; a session from before this version needs a new login. ' +
      'Letting a routine delete data (delete_authorized) is turned on on the 自动任务 page only; no flag or ' +
      'payload here can set it.'
  },
  {
    name: 'checkin',
    summary: 'Check-in campaigns: registrants of a form check in on site',
    note: [
      'Check-in rides on a form: people register by filling the form in, then check in on site.',
      '  1. The form needs a mobile or name field to check in with (`field list --form <token>`),',
      '     and its after-submit action must be the default message.',
      '  2. `checkin create --form <token>` turns it on. Registrants then see a check-in code after submitting.',
      "  3. Share the form's fill link for registration. On site, show `checkin_url` as a QR code",
      '     for registrants to check themselves in, and send `verifier_invite_url` to staff who verify them.',
      '  4. `checkin edit --disable` pauses check-in; records are kept.',
      'The check-in plugin has to be enabled for the account in the plugin center first.',
      'You see and change only the campaigns you created.'
    ].join('\n')
  },
  {
    name: 'fill',
    summary: 'Fill in a form through its fill link',
    note:
      'For a form or a table’s form view you were sent a link to, rather than one you manage. ' +
      'OAuth sessions need the submit_entries scope: `jinshuju auth login --scopes "… submit_entries"`.'
  },
  { name: 'merchant', summary: '小金商户: onboarding, balance and settlement' },
  { name: 'transaction', summary: 'Payment orders placed on payment forms' },
  { name: 'refund', summary: 'Refunds of payment orders' },
  { name: 'payout', summary: 'Payouts to the settlement account' },
  { name: 'sms', summary: 'Manage SMS signatures and templates' },
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
  ...OPENSEARCH,
  ...ROUTINE,
  ...CHECKIN,
  ...FILL,
  ...TRADE,
  ...SMS
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
