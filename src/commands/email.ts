import { PAGINATION_OPTIONS, type OptionSpec } from '../options.js';
import { bodyChoices, call, choices } from '../spec.js';
import {
  DAY_RANGE_OPTIONS,
  dayRange,
  ESTIMATE_OPTION,
  estimating,
  FORM_OPTION,
  given,
  LISTING,
  NARROWING_OPTIONS,
  narrowingBody,
  narrowingQuery,
  paging,
  requiredOption,
  SELECT_ALL_OPTION,
  selectAll,
  SEND_OPTION
} from './shared.js';
import type { Command } from './types.js';

const SMTP_ACCOUNT_OPTION: OptionSpec = {
  name: '--smtp-account-id',
  type: 'string',
  placeholder: '<id>',
  description: "Send through this SMTP account of the account's, from `email smtp-account list`; uses no email quota"
};

const TASK_ARG = [{ name: 'id', required: true, description: 'Task id, from `email task list`' }];

export const EMAIL: readonly Command[] = [
  {
    path: ['email', 'send'],
    summary: 'Send an email to the entries of a form',
    description:
      'Picks the entries the way `entry count` narrows them, or the whole form with --select-all, and sends to the ' +
      'email field --field names. --estimate answers how many entries and addresses it reaches, how many are ' +
      'missing an address and whether the quota covers them, and sends nothing; --yes sends, and wants --subject and ' +
      '--content. The entries are picked again when it sends. Sent email cannot be recalled: after a timeout or a ' +
      'dropped connection, look for the task in `email task list` before sending again, or it may go out twice.',
    options: [
      FORM_OPTION,
      {
        name: '--field',
        type: 'string',
        placeholder: '<api_code>',
        description: 'Email field to send to; a table column as <table api_code>.<column api_code>'
      },
      { name: '--subject', type: 'string', placeholder: '<text>', description: 'Subject' },
      { name: '--content', type: 'string', placeholder: '<html>', description: 'Body, as HTML' },
      SMTP_ACCOUNT_OPTION,
      ...NARROWING_OPTIONS,
      SELECT_ALL_OPTION,
      ESTIMATE_OPTION,
      SEND_OPTION
    ],
    request: (input) => {
      const path = { form_token: requiredOption(input, 'form') };
      const entry_field = requiredOption(input, 'field');
      const smtp_account_id = input.options.smtp_account_id as string | undefined;
      if (estimating(input, 'Sending email')) {
        return call('estimateEmailTask', {
          path,
          query: { entry_field, ...narrowingQuery(input), select_all: selectAll(input), smtp_account_id }
        });
      }
      return call('createEmailTask', {
        path,
        body: given({
          entry_field,
          ...narrowingBody(input),
          select_all: selectAll(input),
          smtp_account_id,
          subject: requiredOption(input, 'subject'),
          content: requiredOption(input, 'content')
        })
      });
    },
    examples: [
      "jinshuju email send --form Kp7mQ2 --field field_3 --filter 'field_5 eq 已报名' --estimate",
      "jinshuju email send --form Kp7mQ2 --field field_3 --filter 'field_5 eq 已报名' --subject 上课提醒 " +
        "--content '<p>明天上午 9 点开课</p>' --yes"
    ]
  },
  {
    path: ['email', 'task', 'list'],
    summary: "List a form's email tasks, newest first, with how many addresses succeeded or failed so far",
    description: '--from and --to pick the tasks by the day they were created. A page holds at most 100 tasks.',
    options: [
      FORM_OPTION,
      {
        name: '--status',
        type: 'string',
        choices: choices('listEmailTasks', 'status'),
        placeholder: '<status>',
        description: 'Only the tasks in this status'
      },
      ...DAY_RANGE_OPTIONS,
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listEmailTasks', {
        path: { form_token: requiredOption(input, 'form') },
        query: { status: input.options.status as string | undefined, ...dayRange(input), ...paging(input) }
      }),
    paginate: LISTING,
    examples: ['jinshuju email task list --form Kp7mQ2', 'jinshuju email task list --form Kp7mQ2 --from 2026-10-01']
  },
  {
    path: ['email', 'task', 'get'],
    summary: 'Show an email task and how many addresses succeeded or failed so far',
    args: TASK_ARG,
    options: [FORM_OPTION],
    request: (input) =>
      call('getEmailTask', { path: { form_token: requiredOption(input, 'form'), id: input.args.id } }),
    examples: ['jinshuju email task get 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2']
  },
  {
    path: ['email', 'task', 'activities'],
    summary: 'List the sending result of each address an email task sent to',
    args: TASK_ARG,
    options: [
      FORM_OPTION,
      {
        name: '--status',
        type: 'string',
        choices: choices('listEmailTaskActivities', 'status'),
        placeholder: '<status>',
        description: 'Only the addresses with this result; both when omitted'
      },
      { name: '--email', type: 'string', placeholder: '<address>', description: 'Only this address' },
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listEmailTaskActivities', {
        path: { form_token: requiredOption(input, 'form'), id: input.args.id },
        query: {
          status: input.options.status as string | undefined,
          email: input.options.email as string | undefined,
          ...paging(input)
        }
      }),
    paginate: LISTING,
    examples: ['jinshuju email task activities 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --status FAILED']
  },
  {
    path: ['email', 'task', 'resend'],
    summary: 'Send an email task again to the entries that got a result',
    description:
      'A new task, with the same subject, content and SMTP account, to the entries of this one that got --status: ' +
      'FAILED, SUCCESS or ALL. A filter, keyword or view narrows them further, and a serial_number none_in condition ' +
      'leaves some out. It sends at once. --estimate answers what it would send and sends nothing; --yes sends.',
    args: TASK_ARG,
    options: [
      FORM_OPTION,
      {
        name: '--status',
        type: 'string',
        choices: bodyChoices('resendEmailTask', 'status'),
        placeholder: '<status>',
        description: 'Send again to the entries with this result; ALL for every one the task sent to'
      },
      ...NARROWING_OPTIONS,
      ESTIMATE_OPTION,
      SEND_OPTION
    ],
    request: (input) => {
      const path = { form_token: requiredOption(input, 'form'), id: input.args.id };
      const status = requiredOption(input, 'status');
      if (estimating(input, `Sending task ${input.args.id} again`)) {
        return call('estimateEmailTaskResend', { path, query: { status, ...narrowingQuery(input) } });
      }
      return call('resendEmailTask', { path, body: given({ status, ...narrowingBody(input) }) });
    },
    examples: [
      'jinshuju email task resend 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --status FAILED --estimate',
      'jinshuju email task resend 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --status FAILED --yes'
    ]
  },
  {
    path: ['email', 'smtp-account', 'list'],
    summary: "List the SMTP accounts the account's email can be sent through",
    description:
      'Empty when the plan does not include custom SMTP. Every member gets the same list. The id goes to ' +
      '`email send --smtp-account-id`.',
    request: () => call('listSmtpAccounts'),
    examples: ['jinshuju email smtp-account list']
  }
];
