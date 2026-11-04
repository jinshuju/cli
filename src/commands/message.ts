import { UsageError } from '../errors.js';
import { call } from '../spec.js';
import { given, requiredOption, SEND_OPTION } from './shared.js';
import type { Command } from './types.js';

export const MESSAGE: readonly Command[] = [
  {
    path: ['message', 'send'],
    summary: 'Send one message through a registered channel: a group robot or webhook, or email and SMS to --to',
    description:
      'Queues the message and answers at once with one record per recipient; a group robot or webhook is the ' +
      'recipient itself. --mention is for DingTalk and WeCom robots only, at most 50; WeCom sends a message that ' +
      'mentions anyone as plain text, so leave Markdown out of it. Sent messages cannot be recalled: after a timeout ' +
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
      { name: '--channel', type: 'string', placeholder: '<id>', description: 'Channel id to send through' },
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
        description: 'The message, in Markdown unless it mentions anyone on WeCom'
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
      return call('sendMessage', {
        body: given({
          type,
          channel_id: input.options.channel as string | undefined,
          to: input.options.to as string[] | undefined,
          title: input.options.title as string | undefined,
          content: input.options.content as string | undefined,
          mentioned_mobile_list: input.options.mention as string[] | undefined,
          idempotency_key: input.options.idempotency_key as string | undefined
        })
      });
    },
    examples: [
      "jinshuju message send --type wxwork --channel 6729f1c2a1b2c3d4e5f60718 --content '今天是星期三，该吃午饭啦！' " +
        '--mention 13800000000 --yes',
      "jinshuju message send --type email --to someone@example.com --title 上课提醒 --content '明天上午 9 点开课' --yes"
    ]
  }
];
