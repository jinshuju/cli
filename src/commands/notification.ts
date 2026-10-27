import { JSON_OPTION, PAGINATION_OPTIONS, UsageError, type OptionSpec } from '../options.js';
import { bodyChoices, call, choices } from '../spec.js';
import {
  DAY_RANGE_OPTIONS,
  LISTING,
  YES_OPTION,
  confirmed,
  dayRange,
  overriding,
  paging,
  requiredOption
} from './shared.js';
import type { Command, CommandInput } from './types.js';

const RULE_ARG = { name: 'rule', required: true, description: 'Notification rule id' };

const FORM_OPTION: OptionSpec = { name: '--form', type: 'string', placeholder: '<token>', description: 'Form token' };

/** What `notification create` and `notification edit` both take. */
const RULE_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--trigger',
    type: 'string',
    choices: bodyChoices('createNotificationRule', 'trigger_scope'),
    placeholder: '<scope>',
    description: 'When it sends; matched_* need scope_conditions and schedule_time a schedule_time_rule, through --json'
  },
  {
    name: '--recipients',
    type: 'list',
    placeholder: '<mobile|email|api-code,...>',
    description: 'SMS and EMAIL: mobiles or emails, or api_codes of the fields holding them'
  },
  {
    name: '--sms-template',
    type: 'string',
    placeholder: '<id>',
    description: 'SMS template id, from `sms template list`'
  },
  {
    name: '--placeholders',
    type: 'list',
    placeholder: '<api-code,...>',
    description: "SMS: the field filling each of the template's $(...) placeholders, in order"
  },
  { name: '--subject', type: 'string', placeholder: '<text>', description: 'EMAIL and WEIXIN_ONETIME subject' },
  { name: '--content', type: 'string', placeholder: '<text>', description: 'Message; $(api_code) inserts a field' },
  {
    name: '--url',
    type: 'string',
    placeholder: '<url>',
    description: 'WXWORK, DING_TALK and WEBHOOK: bot or webhook URL'
  },
  JSON_OPTION
];

function ruleBody(input: CommandInput): Record<string, unknown> {
  const rest = (input.options.json as Record<string, unknown> | undefined) ?? {};
  return overriding(rest, {
    trigger_scope: input.options.trigger,
    recipients: input.options.recipients,
    sms_template_id: input.options.sms_template,
    placeholder_keys: input.options.placeholders,
    subject: input.options.subject,
    content: input.options.content,
    url: input.options.url
  });
}

export const NOTIFICATION: readonly Command[] = [
  {
    path: ['notification', 'list'],
    summary: "List a form's notification rules and whether each can send",
    options: [FORM_OPTION],
    request: (input) => call('listNotificationRules', { path: { form_token: requiredOption(input, 'form') } })
  },
  {
    path: ['notification', 'get'],
    summary: 'Show a notification rule, and why it cannot send if it cannot',
    args: [RULE_ARG],
    options: [FORM_OPTION],
    request: (input) =>
      call('getNotificationRule', { path: { form_token: requiredOption(input, 'form'), id: input.args.rule } })
  },
  {
    path: ['notification', 'create'],
    summary: 'Create a notification rule',
    description:
      'The rule is on once created and sends for the entries that match it from then on; --disable saves it off. ' +
      'An enabled schedule_time rule also schedules, each time it is saved, the entries already in the form ' +
      'whose send time is still ahead. ' +
      'Each approach takes its own keys: SMS --recipients --sms-template --placeholders; ' +
      'EMAIL --recipients --subject --content; WEIXIN_ONETIME --subject --content; ' +
      'WXWORK and DING_TALK --url --content; WEBHOOK --url. ' +
      'scope_conditions, schedule_time_rule, smtp_account_id, weixin_onetime_url and mentioned_mobile_list go through --json.',
    options: [
      FORM_OPTION,
      {
        name: '--approach',
        type: 'string',
        choices: bodyChoices('createNotificationRule', 'approach'),
        placeholder: '<approach>',
        description: 'How it is sent'
      },
      ...RULE_OPTIONS,
      { name: '--disable', type: 'boolean', description: 'Save it turned off' }
    ],
    request: (input) =>
      call('createNotificationRule', {
        path: { form_token: requiredOption(input, 'form') },
        body: overriding(ruleBody(input), {
          approach: requiredOption(input, 'approach'),
          enabled: input.options.disable ? false : undefined
        })
      }),
    examples: [
      'jinshuju notification create --form Kp7mQ2 --approach SMS --recipients field_2 --sms-template 6650a1 --placeholders field_1',
      'jinshuju notification create --form Kp7mQ2 --approach SMS --recipients field_2 --sms-template 6650a1 --placeholders field_1 ' +
        '--trigger schedule_time --json \'{"schedule_time_rule":{"date_key":"field_5","date_offset_action":"before",' +
        '"date_offset_number":1,"date_offset_unit":"day","hour":9,"minute":0}}\'',
      'jinshuju notification create --form Kp7mQ2 --approach EMAIL --recipients field_3 --subject 报名成功 ' +
        "--content '$(field_1) 你好，报名已收到' --trigger matched_new " +
        '--json \'{"scope_conditions":[{"trigger":"field_5","operator":"any_in","value":["choice_1"]}]}\''
    ]
  },
  {
    path: ['notification', 'edit'],
    summary: 'Edit a notification rule, or turn it off and on',
    description: 'Only what is named changes. The approach cannot be changed; create another rule instead.',
    args: [RULE_ARG],
    options: [
      FORM_OPTION,
      ...RULE_OPTIONS,
      { name: '--enable', type: 'boolean', description: 'Turn the rule on' },
      { name: '--disable', type: 'boolean', description: 'Turn the rule off' }
    ],
    request: (input) => {
      if (input.options.enable && input.options.disable) {
        throw new UsageError('--enable and --disable are opposites, pass one');
      }
      return call('updateNotificationRule', {
        path: { form_token: requiredOption(input, 'form'), id: input.args.rule },
        body: overriding(ruleBody(input), {
          enabled: input.options.enable ? true : input.options.disable ? false : undefined
        })
      });
    },
    examples: ['jinshuju notification edit 6650b2 --form Kp7mQ2 --disable']
  },
  {
    path: ['notification', 'delete'],
    summary: 'Delete a notification rule',
    description:
      'What it has scheduled but not sent yet is cancelled. To stop it for now, use `notification edit --disable`.',
    args: [RULE_ARG],
    options: [FORM_OPTION, YES_OPTION],
    request: (input) => {
      confirmed(input, `Deleting notification rule ${input.args.rule}`);
      return call('deleteNotificationRule', {
        path: { form_token: requiredOption(input, 'form'), id: input.args.rule }
      });
    }
  },
  {
    path: ['notification', 'log'],
    summary: 'List what a notification rule sent, with how many succeeded or failed and why',
    description:
      'Covers the last 180 days, as the notification log page does; notifications scheduled for later are not listed. ' +
      '--from and --to pick them by the day they were sent. The summary counts every match, not just the page; ' +
      '--output jsonl carries the notifications alone, without it.',
    args: [RULE_ARG],
    options: [
      FORM_OPTION,
      {
        name: '--status',
        type: 'string',
        choices: choices('listNotificationRuleNotifications', 'status'),
        placeholder: '<status>',
        description: 'Only the notifications in this status, e.g. FAILED'
      },
      ...DAY_RANGE_OPTIONS,
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listNotificationRuleNotifications', {
        path: { form_token: requiredOption(input, 'form'), id: input.args.rule },
        query: { status: input.options.status as string | undefined, ...dayRange(input), ...paging(input) }
      }),
    paginate: { ...LISTING, totals: ['triggered_count', 'summary'] },
    examples: [
      'jinshuju notification log 6650b2 --form Kp7mQ2',
      'jinshuju notification log 6650b2 --form Kp7mQ2 --status FAILED --from 2026-10-01 --to 2026-10-31'
    ]
  }
];
