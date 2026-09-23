import { CONTAINER_OPTIONS, UsageError, type OptionSpec } from '../options.js';
import { YES_OPTION, confirmed, containerPath, given } from './shared.js';
import type { Command, CommandInput } from './types.js';

/** A comment lives under its entry, so every verb needs the entry as well. */
const ENTRY_OPTION: OptionSpec = {
  name: '--entry',
  type: 'string',
  placeholder: '<serial>',
  description: 'Entry serial number'
};

function commentsPath(input: CommandInput): string {
  const serial = input.options.entry as string | undefined;
  if (!serial) throw new UsageError('--entry <serial> is required');
  return `${containerPath(input)}/entries/${serial}/comments`;
}

export const COMMENT: readonly Command[] = [
  {
    path: ['comment', 'list'],
    summary: "List an entry's comments",
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--entry', type: 'string', placeholder: '<serial>', description: 'Entry serial number' }
    ],
    request: (input) => ({ method: 'GET', path: commentsPath(input) })
  },
  {
    path: ['comment', 'create'],
    summary: 'Comment on an entry',
    args: [{ name: 'content', required: true, description: 'Comment text' }],
    options: [
      ...CONTAINER_OPTIONS,
      ENTRY_OPTION,
      { name: '--reply-to', type: 'string', placeholder: '<comment-id>', description: 'Reply under this comment' }
    ],
    request: (input) => ({
      method: 'POST',
      path: `${commentsPath(input)}`,
      body: given({ content: input.args.content, parent_id: input.options.reply_to })
    }),
    examples: ['jinshuju comment create --form Kp7mQ2 --entry 12 "已联系，等回复"']
  },
  {
    path: ['comment', 'update'],
    summary: 'Edit a comment',
    args: [
      { name: 'comment', required: true, description: 'Comment id' },
      { name: 'content', required: true, description: 'New comment text' }
    ],
    options: [...CONTAINER_OPTIONS, ENTRY_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: `${commentsPath(input)}/${input.args.comment}`,
      body: { content: input.args.content }
    })
  },
  {
    path: ['comment', 'delete'],
    summary: 'Delete a comment',
    args: [{ name: 'comment', required: true, description: 'Comment id' }],
    options: [...CONTAINER_OPTIONS, ENTRY_OPTION, YES_OPTION],
    request: (input) => {
      confirmed(input, `Deleting comment ${input.args.comment}`);
      return { method: 'DELETE', path: `${commentsPath(input)}/${input.args.comment}` };
    }
  }
];
