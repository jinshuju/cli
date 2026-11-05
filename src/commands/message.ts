import { UsageError } from '../errors.js';
import { PAGINATION_OPTIONS } from '../options.js';
import { call, choices } from '../spec.js';
import { given, LISTING, paging, requiredOption, SEND_OPTION } from './shared.js';
import type { Command } from './types.js';

/** `var_1=张三`: one variable of an SMS channel's template. */
function parseVariable(input: string): [string, string] {
  const at = input.indexOf('=');
  if (at <= 0) throw new UsageError(`--variable must be '<name>=<value>', got ${JSON.stringify(input)}`);
  return [input.slice(0, at), input.slice(at + 1)];
}

export const MESSAGE: readonly Command[] = [
  {
    path: ['message', 'send'],
    summary: 'Send one message through a registered channel: a group robot or webhook, or email and SMS to --to',
    description:
      'Queues the message and answers at once with one record per recipient; a group robot or webhook is the ' +
      'recipient itself. --mention is for DingTalk and WeCom robots only, at most 50; WeCom sends a message that ' +
      "mentions anyone as plain text, so leave Markdown out of it. SMS sends the channel's template, so it takes no " +
      '--title or --content: give each of its variables with --variable. Sent messages cannot be recalled: after a timeout ' +
      'or a dropped connection, send again with the same --idempotency-key, which answers the first records instead ' +
      'of sending twice. --yes sends.',
    options: [
      {
        name: '--type',
        type: 'string',
        choices: ['wxwork', 'ding_talk', 'webhook', 'email', 'sms'],
        placeholder: '<type>',
        description: 'wxwork, ding_talk, webhook, email or sms'
      },
      {
        name: '--channel',
        type: 'string',
        placeholder: '<id>',
        description:
          'Channel id, from `message channel list`. Required for a group robot, a webhook and SMS (an SMS channel sends ' +
          "one template, once approved). Email may leave it out: it then goes from Jinshuju's address and uses the " +
          "email quota; with one it goes through that channel's SMTP account"
      },
      {
        name: '--to',
        type: 'string',
        repeatable: true,
        placeholder: '<recipient>',
        description: 'Email address or mobile number for email and SMS, repeatable, at most 50'
      },
      {
        name: '--title',
        type: 'string',
        placeholder: '<text>',
        description: 'Heading above the content, or the subject of an email'
      },
      {
        name: '--content',
        type: 'string',
        placeholder: '<text>',
        description:
          "The message, in Markdown unless it mentions anyone on WeCom; an email's becomes HTML and takes up to " +
          '20,000 characters'
      },
      {
        name: '--variable',
        type: 'string',
        repeatable: true,
        placeholder: '<name>=<value>',
        description:
          "Every variable the SMS channel's template declares, as it is named there (var_1...), each 1 to 100 " +
          'characters; repeatable'
      },
      {
        name: '--mention',
        type: 'string',
        repeatable: true,
        placeholder: '<mobile|@all>',
        description: 'Group member to @ by mobile number, or @all for everyone; repeatable'
      },
      {
        name: '--idempotency-key',
        type: 'string',
        placeholder: '<key>',
        description: 'Sends once for the same key within 24 hours; retry with the same key'
      },
      SEND_OPTION
    ],
    request: (input) => {
      const type = requiredOption(input, 'type');
      if (!input.options.yes) throw new UsageError('A sent message cannot be recalled; pass --yes to send');
      const variables = input.options.variable as string[] | undefined;
      return call('sendMessage', {
        body: given({
          type,
          channel_id: input.options.channel as string | undefined,
          to: input.options.to as string[] | undefined,
          title: input.options.title as string | undefined,
          content: input.options.content as string | undefined,
          variables: variables && Object.fromEntries(variables.map(parseVariable)),
          mentioned_mobile_list: input.options.mention as string[] | undefined,
          idempotency_key: input.options.idempotency_key as string | undefined
        })
      });
    },
    examples: [
      "jinshuju message send --type wxwork --channel 6729f1c2a1b2c3d4e5f60718 --content '今天是星期三，该吃午饭啦！' " +
        '--mention 13800000000 --yes',
      "jinshuju message send --type email --to someone@example.com --title 上课提醒 --content '明天上午 9 点开课' --yes",
      'jinshuju message send --type sms --channel 6729f1c2a1b2c3d4e5f60719 --to 13800000000 --variable var_1=张三 ' +
        '--variable var_2=9:00 --yes'
    ]
  },
  {
    path: ['message', 'channel', 'list'],
    summary: 'List the channels `message send` can send through, newest first',
    description:
      'The channels you registered, or every channel of the account for an account access token. The id goes to ' +
      '`message send --channel`. address is the robot or webhook address with its key hidden, empty for email and ' +
      'SMS; an email channel carries its smtp_account_id and an SMS one its sms_template_id.',
    options: [
      {
        name: '--type',
        type: 'string',
        choices: choices('listMessageChannels', 'type'),
        placeholder: '<type>',
        description: 'Only the channels of this type: wxwork, ding_talk, webhook, email or sms'
      },
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listMessageChannels', { query: { type: input.options.type as string | undefined, ...paging(input) } }),
    paginate: LISTING,
    examples: ['jinshuju message channel list', 'jinshuju message channel list --type sms']
  },
  {
    path: ['message', 'channel', 'get'],
    summary: 'Show a channel `message send` can send through',
    args: [{ name: 'id', required: true, description: 'Channel id, from `message channel list`' }],
    request: (input) => call('getMessageChannel', { path: { id: input.args.id } }),
    examples: ['jinshuju message channel get 6729f1c2a1b2c3d4e5f60718']
  }
];
