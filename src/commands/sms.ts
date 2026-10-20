import type { HttpClient } from '../http.js';
import { PAGINATION_OPTIONS, UsageError, type OptionSpec } from '../options.js';
import { progress } from '../progress.js';
import { bodyChoices, call, choices } from '../spec.js';
import { confirmed, LISTING, paging, YES_OPTION } from './shared.js';
import type { Command, CommandInput } from './types.js';
import { upload } from './upload.js';
import { basename } from 'node:path';

/**
 * A signature is applied for with license images, which go up first as the
 * caller's own uploads and are then referred to by id. The review takes a
 * business license and both sides of the ID card of whoever is in charge.
 */
const SIGNATURE_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--license',
    type: 'string',
    repeatable: true,
    placeholder: '<file>',
    description: 'Business license image (jpg, png or bmp, up to 5 MB), repeatable'
  },
  { name: '--company-name', type: 'string', placeholder: '<name>', description: 'Company name, as on the license' },
  {
    name: '--company-id',
    type: 'string',
    placeholder: '<code>',
    description: 'Unified social credit code, as on the license'
  },
  {
    name: '--id-card-front',
    type: 'string',
    placeholder: '<file>',
    description: 'ID card front (the national emblem side)'
  },
  { name: '--id-card-back', type: 'string', placeholder: '<file>', description: 'ID card back (the portrait side)' },
  { name: '--id-card-name', type: 'string', placeholder: '<name>', description: 'Name on the ID card' },
  { name: '--id-card-number', type: 'string', placeholder: '<number>', description: 'ID card number' },
  { name: '--mobile', type: 'string', placeholder: '<mobile>', description: 'Mobile number of the ID card holder' }
];

/** The flags that go as they are, by the key the API takes each by. */
const SIGNATURE_TEXT = [
  { key: 'company_name', option: 'company_name', flag: '--company-name <name>' },
  { key: 'company_id', option: 'company_id', flag: '--company-id <code>' },
  { key: 'id_card_name', option: 'id_card_name', flag: '--id-card-name <name>' },
  { key: 'id_card_number', option: 'id_card_number', flag: '--id-card-number <number>' },
  { key: 'identity_mobile', option: 'mobile', flag: '--mobile <mobile>' }
] as const;

/** The flags that name a file, uploaded and then sent by the id it gets. */
const SIGNATURE_FILES = [
  { key: 'id_card_front_attachment_id', option: 'id_card_front', flag: '--id-card-front <file>' },
  { key: 'id_card_back_attachment_id', option: 'id_card_back', flag: '--id-card-back <file>' }
] as const;

const TEMPLATE_DESCRIPTION_OPTION: OptionSpec = {
  name: '--description',
  type: 'string',
  placeholder: '<text>',
  description: 'What the SMS is for, shown to the reviewer'
};

function requiredOption(input: CommandInput, key: string, flag: string): string {
  const value = input.options[key] as string | undefined;
  if (!value) throw new UsageError(`${flag} is required`);
  return value;
}

function licensesOf(input: CommandInput): string[] {
  return (input.options.license as string[] | undefined) ?? [];
}

async function uploadLicense(client: HttpClient, file: string): Promise<string> {
  const watching = progress();
  watching.step(`uploading ${basename(file)}…`);
  try {
    const uploaded = await client.request<{ attachment_id: string }>(upload('uploadUserLicenseAttachment', {}, file));
    return uploaded.attachment_id;
  } finally {
    watching.done();
  }
}

/**
 * The materials the flags give, with their files uploaded. Only the flags that
 * were given are in it, which is what an update needs: what is left out stays.
 */
async function signatureMaterials(input: CommandInput, client: HttpClient): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  for (const { key, option } of SIGNATURE_TEXT) {
    if (input.options[option] !== undefined) body[key] = input.options[option];
  }
  const licenses = licensesOf(input);
  if (licenses.length > 0) {
    const ids: string[] = [];
    for (const license of licenses) ids.push(await uploadLicense(client, license));
    body.license_attachment_ids = ids;
  }
  for (const { key, option } of SIGNATURE_FILES) {
    const file = input.options[option] as string | undefined;
    if (file) body[key] = await uploadLicense(client, file);
  }
  return body;
}

/** Only the keys whose flags were given, so an update leaves the rest as it was. */
function templateBody(input: CommandInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.options.signature !== undefined) body.signature = input.options.signature;
  if (input.options.content !== undefined) body.content = input.options.content;
  if (input.options.description !== undefined) body.apply_description = input.options.description;
  return body;
}

export const SMS: readonly Command[] = [
  {
    path: ['sms', 'status'],
    summary: 'List SMS signatures and templates with their review status and why a review failed',
    description: 'Your own signatures and templates, not those of the rest of the account.',
    request: () => call('listSmsAuditStatuses')
  },
  {
    path: ['sms', 'signature', 'list'],
    summary: "List the account's SMS signatures",
    description:
      'Every signature of the account, whoever applied for it, with the ids `sms signature update` and ' +
      '`sms signature delete` take. type says what each signs: notification, SMS sent from templates (channel ' +
      'normal or marketing), or verification, the verification codes of mobile fields only. Templates can only be ' +
      'created under a notification one whose channel is normal.',
    options: [
      {
        name: '--status',
        type: 'string',
        choices: choices('listSmsSignatures', 'status'),
        placeholder: '<status>',
        description: 'Only those in this review status, e.g. FAIL for the ones that can be changed or deleted'
      },
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listSmsSignatures', { query: { status: input.options.status as string | undefined, ...paging(input) } }),
    paginate: LISTING,
    examples: ['jinshuju sms signature list', 'jinshuju sms signature list --status FAIL']
  },
  {
    path: ['sms', 'signature', 'create'],
    summary: 'Apply for an SMS signature and submit it for review',
    description:
      'Uploads the license images and applies with them in one command. Review takes a while: follow it with ' +
      '`sms signature list`. A signature the account already has under review or approved is answered as it is. ' +
      'For SMS notifications leave --type out. --type verification applies for a signature that only replaces ' +
      'the default 金数据 signature on the verification-code SMS of mobile fields: it cannot send notifications or ' +
      'have templates, and verification codes already work without one.',
    args: [{ name: 'signature', required: true, description: 'Signature text, without 【】' }],
    options: [
      {
        name: '--type',
        type: 'string',
        choices: bodyChoices('createSmsSignature', 'type'),
        placeholder: '<type>',
        description:
          'notification (SMS notifications, the default) or verification (verification codes of mobile fields only)'
      },
      ...SIGNATURE_OPTIONS
    ],
    run: async (input, client) => {
      if (licensesOf(input).length === 0) throw new UsageError('--license <file> is required');
      for (const { option, flag } of [...SIGNATURE_TEXT, ...SIGNATURE_FILES]) requiredOption(input, option, flag);

      const body: Record<string, unknown> = {
        signature: input.args.signature,
        ...(await signatureMaterials(input, client))
      };
      if (input.options.type !== undefined) body.type = input.options.type;
      return client.request(call('createSmsSignature', { body }));
    },
    examples: [
      'jinshuju sms signature create 小金培训 --license ./license.jpg --company-name 小金培训有限公司 ' +
        '--company-id 91110000MA00000000 --id-card-front ./front.jpg --id-card-back ./back.jpg ' +
        '--id-card-name 张三 --id-card-number 110101199001011234 --mobile 13800000000'
    ]
  },
  {
    path: ['sms', 'signature', 'update'],
    summary: 'Change a rejected SMS signature and submit it for review again',
    description:
      'Only a rejected signature can be changed. Only the flags given change; with none, it is submitted again ' +
      'as it is. Its templates go back to review with it, unless --signature changes the text: then each ' +
      'stays under the old text until `sms template update` sends it again.',
    args: [{ name: 'id', required: true, description: 'Signature id, from `sms signature list`' }],
    options: [
      { name: '--signature', type: 'string', placeholder: '<text>', description: 'New signature text, without 【】' },
      ...SIGNATURE_OPTIONS
    ],
    run: async (input, client) => {
      const body = await signatureMaterials(input, client);
      if (input.options.signature !== undefined) body.signature = input.options.signature;
      return client.request(call('updateSmsSignature', { path: { id: input.args.id }, body }));
    },
    examples: ['jinshuju sms signature update 6512a1c2d3e4f5a6b7c8d9d3 --license ./license-clear.jpg']
  },
  {
    path: ['sms', 'signature', 'delete'],
    summary: 'Delete a rejected SMS signature, and every template under it',
    description: 'Only a rejected signature can be deleted. Its templates go with it.',
    args: [{ name: 'id', required: true, description: 'Signature id, from `sms signature list`' }],
    options: [YES_OPTION],
    request: (input) => {
      confirmed(input, `Deleting signature ${input.args.id} and its templates`);
      return call('deleteSmsSignature', { path: { id: input.args.id } });
    },
    examples: ['jinshuju sms signature delete 6512a1c2d3e4f5a6b7c8d9d3 --yes']
  },
  {
    path: ['sms', 'template', 'list'],
    summary: 'List your SMS templates and the ones the account shares',
    description:
      'scope owned is yours and can be changed or deleted with the ids it carries; scope shared is shared by ' +
      'another member and can only be sent.',
    options: [
      {
        name: '--keyword',
        type: 'string',
        placeholder: '<kw>',
        description: 'Match the content or the signature, case-insensitive and partial'
      },
      {
        name: '--scope',
        type: 'string',
        choices: choices('listSmsTemplates', 'scope'),
        placeholder: '<scope>',
        description: 'owned (yours) or shared (shared by another member); both when omitted'
      },
      {
        name: '--signature-id',
        type: 'string',
        placeholder: '<id>',
        description: 'Only templates under this signature, from `sms signature list`'
      },
      {
        name: '--status',
        type: 'string',
        choices: choices('listSmsTemplates', 'status'),
        placeholder: '<status>',
        description: 'Only those in this review status'
      },
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listSmsTemplates', {
        query: {
          q: input.options.keyword as string | undefined,
          scope: input.options.scope as string | undefined,
          signature_id: input.options.signature_id as string | undefined,
          status: input.options.status as string | undefined,
          ...paging(input)
        }
      }),
    paginate: LISTING,
    examples: ['jinshuju sms template list --keyword 开课', 'jinshuju sms template list --scope owned --status FAIL']
  },
  {
    path: ['sms', 'template', 'create'],
    summary: 'Submit an SMS template for review',
    description:
      'The signature must have been applied for, though it need not be approved yet. Review takes a while: ' +
      'follow it with `sms status`. Once approved, the template id is what a notification sends.',
    options: [
      { name: '--signature', type: 'string', placeholder: '<signature>', description: 'Signature to send it under' },
      {
        name: '--content',
        type: 'string',
        placeholder: '<text>',
        description: 'Template content, without the signature'
      },
      TEMPLATE_DESCRIPTION_OPTION
    ],
    request: (input) => {
      requiredOption(input, 'signature', '--signature <signature>');
      requiredOption(input, 'content', '--content <text>');
      return call('createSmsTemplate', { body: templateBody(input) });
    },
    examples: [
      'jinshuju sms template create --signature 小金培训 --content "你报名的课程明天上午 9 点开课，请准时参加。"'
    ]
  },
  {
    path: ['sms', 'template', 'update'],
    summary: 'Change an SMS template and submit it for review again',
    description:
      'Not while it is under review. Only the flags given change; with none, it is submitted again as it is. ' +
      'An approved template goes back to review and cannot be sent until approved again.',
    args: [{ name: 'id', required: true, description: 'Template id, from `sms template list`' }],
    options: [
      {
        name: '--signature',
        type: 'string',
        placeholder: '<signature>',
        description: 'Send it under this signature instead'
      },
      { name: '--content', type: 'string', placeholder: '<text>', description: 'New content, without the signature' },
      TEMPLATE_DESCRIPTION_OPTION
    ],
    request: (input) => call('updateSmsTemplate', { path: { id: input.args.id }, body: templateBody(input) }),
    examples: ['jinshuju sms template update 6512a1c2d3e4f5a6b7c8d9e0 --content "你报名的课程后天上午 9 点开课。"']
  },
  {
    path: ['sms', 'template', 'delete'],
    summary: 'Delete an SMS template',
    description:
      'Not while it is under review or being sent. A notification sending it stops sending SMS once it is gone.',
    args: [{ name: 'id', required: true, description: 'Template id, from `sms template list`' }],
    options: [YES_OPTION],
    request: (input) => {
      confirmed(input, `Deleting template ${input.args.id}`);
      return call('deleteSmsTemplate', { path: { id: input.args.id } });
    },
    examples: ['jinshuju sms template delete 6512a1c2d3e4f5a6b7c8d9e0 --yes']
  }
];
