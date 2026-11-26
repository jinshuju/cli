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
import { ARTIFACT } from './artifact.js';
import { CHECKIN } from './checkin.js';
import { COMMENT } from './comment.js';
import { EMAIL } from './email.js';
import { ENTRY } from './entry.js';
import { FIELD } from './field.js';
import { FILL } from './fill.js';
import { FOLDER } from './folder.js';
import { FORM } from './form.js';
import { LOCAL } from './local.js';
import { MESSAGE } from './message.js';
import { NOTIFICATION } from './notification.js';
import { OPENSEARCH } from './opensearch.js';
import { PSEUDO_FORM } from './pseudo-form.js';
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
  { name: 'form', summary: 'Manage forms' },
  { name: 'table', summary: 'Manage tables' },
  { name: 'field', summary: 'Manage fields' },
  { name: 'view', summary: 'Manage views' },
  { name: 'entry', summary: 'Manage entries' },
  { name: 'comment', summary: 'Manage entry comments' },
  { name: 'opensearch', summary: 'Manage public queries' },
  {
    name: 'pseudo-form',
    summary: 'Pseudo forms (预填写): fill links with some fields already filled in, one per person or row',
    note: 'Only a manager of the form can create, edit or delete them, and the form’s account needs 数据预填写 in its plan.'
  },
  {
    name: 'notification',
    summary: 'Notification rules: SMS, email and WeChat to submitters, bots and webhooks to your team',
    note:
      'An SMS rule needs an approved template of your own, shared in the account or official (`sms template list`). ' +
      'A rule under review is saved but does not send; `notification get` says why a rule cannot send. ' +
      'Only a manager of the form can create, edit or delete its rules. `notification edit --disable` turns a rule off for now.'
  },
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
  { name: 'sms', summary: 'Manage SMS signatures and templates, and send SMS to entries' },
  { name: 'email', summary: 'Send email to entries' },
  {
    name: 'message',
    summary: 'Send one message through a registered channel: group robots, webhooks, email and SMS; list the channels'
  },
  {
    name: 'artifact',
    summary: 'Artifacts Jiri made in a conversation: find and download them, and who can open an HTML one by its link',
    note:
      'OAuth sessions need the artifacts scope. `jinshuju auth login` asks for it; a session from ' +
      'an older CLI has to log in again. An account access token is refused: an artifact belongs to a person.'
  },
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
  ...PSEUDO_FORM,
  ...NOTIFICATION,
  ...ROUTINE,
  ...CHECKIN,
  ...FILL,
  ...TRADE,
  ...SMS,
  ...EMAIL,
  ...MESSAGE,
  ...ARTIFACT
];

/**
 * Words that name the same verb. Some resources delete and others remove, after
 * what the API calls it, and nobody remembers which; either one reaches the
 * command, and the one written out still wins where both exist.
 */
const SAME_VERB: Readonly<Record<string, string>> = { delete: 'remove', remove: 'delete' };

/** The command whose path the words begin with, longest match first; a spelled-out match beats a synonym. */
export function findCommand(words: readonly string[], commands: readonly Command[] = COMMANDS): Command | undefined {
  let best: Command | undefined;
  let bestExact = false;
  for (const command of commands) {
    if (command.path.length > words.length) continue;
    const parts = command.path.map((part, index) =>
      words[index] === part ? 'exact' : SAME_VERB[words[index] as string] === part ? 'synonym' : 'miss'
    );
    if (parts.includes('miss')) continue;
    const exact = !parts.includes('synonym');
    const longer = !best || command.path.length > best.path.length;
    const tieWon = best !== undefined && command.path.length === best.path.length && exact && !bestExact;
    if (longer || tieWon) {
      best = command;
      bestExact = exact;
    }
  }
  return best;
}
