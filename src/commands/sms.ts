import type { HttpClient } from '../http.js';
import { PAGINATION_OPTIONS, UsageError, type OptionSpec } from '../options.js';
import { progress } from '../progress.js';
import { bodyChoices, call, choices } from '../spec.js';
import {
  confirmed,
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
  requiredOption as required,
  SELECT_ALL_OPTION,
  selectAll,
  SEND_OPTION,
  sendingConfirmed,
  YES_OPTION
} from './shared.js';
import type { Command, CommandInput } from './types.js';
import { upload } from './upload.js';
import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';

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

const TEMPLATE_VARIABLE_OPTION: OptionSpec = {
  name: '--variable',
  type: 'string',
  repeatable: true,
  placeholder: '<label>:<type>:<example>',
  description:
    'Declare the next of $(var_1), $(var_2)... the content uses, repeatable in that order; type is one of ' +
    'code, nickname, name, address, amount, link, time, other, e.g. 姓名:name:姓名，示例：张三; the example takes 6 characters or more'
};

const VARIABLE_SHAPE = "--variable must be '<label>:<type>:<example>'";

/** `姓名:name:姓名，示例：张三`; the example keeps any further `:`, as a time or a link has. */
function parseVariable(input: string): Record<string, string> {
  const [label, type, ...rest] = input.split(':');
  const example = rest.join(':');
  if (!label || !type || !example) throw new UsageError(`${VARIABLE_SHAPE}, got ${JSON.stringify(input)}`);
  return { label, type, example };
}

function requiredOption(input: CommandInput, key: string, flag: string): string {
  const value = input.options[key] as string | undefined;
  if (!value) throw new UsageError(`${flag} is required`);
  return value;
}

function licensesOf(input: CommandInput): string[] {
  return (input.options.license as string[] | undefined) ?? [];
}

const LICENSE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp'];
const LICENSE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Every image is checked before the first goes up: once one is uploaded, a
 * failure on the next leaves it behind, and running the command again sends
 * the license and ID card images a second time.
 */
function checkLicenseFiles(files: readonly string[]): void {
  for (const file of files) {
    if (!LICENSE_EXTENSIONS.includes(extname(file).toLowerCase())) {
      throw new UsageError(`${file} is not a jpg, jpeg, png or bmp image`);
    }
    let size: number;
    try {
      size = statSync(file).size;
    } catch (error) {
      throw new UsageError(`could not read ${file}: ${(error as Error).message}`);
    }
    if (size > LICENSE_MAX_BYTES) throw new UsageError(`${file} is over 5 MB`);
  }
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
  const idCards = SIGNATURE_FILES.map(({ option }) => input.options[option] as string | undefined);
  checkLicenseFiles([...licenses, ...idCards.filter((file): file is string => Boolean(file))]);
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

const MOBILE_FIELD_OPTION: OptionSpec = {
  name: '--field',
  type: 'string',
  placeholder: '<api_code>',
  description: 'Mobile field to send to; a table column as <table api_code>.<column api_code>'
};

const TEMPLATE_ID_OPTION: OptionSpec = {
  name: '--template-id',
  type: 'string',
  placeholder: '<id>',
  description: 'Template to send, from `sms template list`'
};

const TIMING_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--placeholder',
    type: 'string',
    repeatable: true,
    placeholder: '<api_code>',
    description:
      'Field filling the next template variable, repeatable in variable order; a variable without one takes the ' +
      'field whose api_code is its name'
  },
  {
    name: '--send-at',
    type: 'string',
    placeholder: '<time>',
    description: 'Send at this future time, ISO 8601 with a time zone offset, e.g. 2026-10-24T09:00:00+08:00'
  },
  { name: '--manual', type: 'boolean', description: 'Wait to be sent with `sms task send` once it passes review' }
];

const TASK_ARG = [{ name: 'id', required: true, description: 'Task id, from `sms task list`' }];

function placeholders(input: CommandInput): string[] | undefined {
  const keys = (input.options.placeholder as string[] | undefined) ?? [];
  return keys.length > 0 ? keys : undefined;
}

/** When and how it sends, only as far as the flags say. */
function timing(input: CommandInput): Record<string, unknown> {
  return {
    placeholder_keys: placeholders(input),
    send_at: input.options.send_at as string | undefined,
    auto_send: input.options.manual ? false : undefined
  };
}

/** Only the keys whose flags were given, so an update leaves the rest as it was. */
function templateBody(input: CommandInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.options.signature !== undefined) body.signature = input.options.signature;
  if (input.options.content !== undefined) body.content = input.options.content;
  if (input.options.description !== undefined) body.apply_description = input.options.description;
  const variables = input.options.variable as string[] | undefined;
  if (variables?.length) body.variables = variables.map(parseVariable);
  return body;
}

interface SmsTemplate {
  id: string;
  content: string;
  status: string;
  reason?: string | null;
}

interface SmsSignature {
  id: string;
  signature: string;
  status: string;
  reason?: string | null;
  templates?: SmsTemplate[];
}

/**
 * One row per template, carrying its signature, so the template id a
 * notification rule sends with is on the screen. A signature without
 * templates still gets a row, for its own review status.
 */
function templatesForReading(body: unknown): unknown {
  const signatures = (body as { signatures?: SmsSignature[] }).signatures ?? [];
  const data = signatures.flatMap((signature) => {
    const own = {
      signature: signature.signature,
      signature_status: signature.status,
      signature_reason: signature.reason
    };
    const templates = signature.templates ?? [];
    if (templates.length === 0) return [own];
    return templates.map((template) => ({
      template_id: template.id,
      ...own,
      template_status: template.status,
      template_reason: template.reason,
      content: template.content
    }));
  });
  return { data };
}

export const SMS: readonly Command[] = [
  {
    path: ['sms', 'status'],
    summary: 'List SMS signatures and templates with their review status and why a review failed',
    description:
      'Your own signatures and templates, not those of the rest of the account. ' +
      'To pick a template to send, use `sms template list`, which also has the ones the account shares and the ' +
      'official ones.',
    request: () => call('listSmsAuditStatuses'),
    render: templatesForReading
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
      "The materials replace your ID card information, and the account's business license unless the account " +
      'has passed license verification. ' +
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
    summary: 'List your SMS templates, the ones the account shares and the official ones',
    description:
      'scope owned is yours and can be changed or deleted with the ids it carries; scope shared is shared by ' +
      'another member and can only be sent; scope official is approved already and can be sent right away, even ' +
      'while your own signature and templates are under review. Official ones come last, with scene marking the ' +
      'forms they are worded for: form ones suit any form, and any form can send with any of them. variables are ' +
      'in the order `--placeholder` fills them when sending.',
    options: [
      {
        name: '--keyword',
        type: 'string',
        placeholder: '<kw>',
        description:
          'Match the content or the signature, case-insensitive and partial; only the content of official ones'
      },
      {
        name: '--scope',
        type: 'string',
        choices: choices('listSmsTemplates', 'scope'),
        placeholder: '<scope>',
        description: 'owned (yours), shared (shared by another member) or official; all three when omitted'
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
    examples: [
      'jinshuju sms template list --keyword 开课',
      'jinshuju sms template list --scope owned --status FAIL',
      'jinshuju sms template list --scope official'
    ]
  },
  {
    path: ['sms', 'template', 'create'],
    summary: 'Submit an SMS template for review',
    description:
      'The signature must have been applied for, though it need not be approved yet. Review takes a while: ' +
      'follow it with `sms status`. Once approved, the template id is what a notification sends. Variables are ' +
      'written $(var_1), $(var_2)... in the content, each once, and each declared with --variable.',
    options: [
      { name: '--signature', type: 'string', placeholder: '<signature>', description: 'Signature to send it under' },
      {
        name: '--content',
        type: 'string',
        placeholder: '<text>',
        description: 'Template content, without the signature'
      },
      TEMPLATE_DESCRIPTION_OPTION,
      TEMPLATE_VARIABLE_OPTION
    ],
    request: (input) => {
      requiredOption(input, 'signature', '--signature <signature>');
      requiredOption(input, 'content', '--content <text>');
      return call('createSmsTemplate', { body: templateBody(input) });
    },
    examples: [
      'jinshuju sms template create --signature 小金培训 --content "你报名的课程明天上午 9 点开课，请准时参加。"',
      "jinshuju sms template create --signature 小金培训 --content '$(var_1)，你好，套餐 $(var_2) 到期。' " +
        '--variable 姓名:name:姓名，示例：张三 --variable 到期日期:time:2026-10-25'
    ]
  },
  {
    path: ['sms', 'template', 'update'],
    summary: 'Change an SMS template and submit it for review again',
    description:
      'Not while it is under review. Only the flags given change; with none, it is submitted again as it is. ' +
      'An approved template goes back to review and cannot be sent until approved again. Changing the variables ' +
      'of the content takes a --variable for each; while a notification or an SMS task sends the template, only ' +
      'the text around them can change.',
    args: [{ name: 'id', required: true, description: 'Template id, from `sms template list`' }],
    options: [
      {
        name: '--signature',
        type: 'string',
        placeholder: '<signature>',
        description: 'Send it under this signature instead'
      },
      { name: '--content', type: 'string', placeholder: '<text>', description: 'New content, without the signature' },
      TEMPLATE_DESCRIPTION_OPTION,
      TEMPLATE_VARIABLE_OPTION
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
  },
  {
    path: ['sms', 'send'],
    summary: 'Send an SMS template to the entries of a form',
    description:
      'Picks the entries the way `entry count` narrows them, or the whole form with --select-all, and sends to the ' +
      'mobile field --field names. --estimate answers how many entries and numbers it reaches, how many are missing ' +
      'a number, the SMS it bills and whether the quota covers them, and sends nothing; --yes sends. The entries are ' +
      'picked again when it sends, so a change in between changes what goes out. A template still under review is ' +
      'taken, and the task waits for it. Sent SMS cannot be recalled: after a timeout or a dropped connection, ' +
      'look for the task in `sms task list` before sending again, or it may go out twice.',
    options: [
      FORM_OPTION,
      MOBILE_FIELD_OPTION,
      TEMPLATE_ID_OPTION,
      ...TIMING_OPTIONS,
      ...NARROWING_OPTIONS,
      SELECT_ALL_OPTION,
      ESTIMATE_OPTION,
      SEND_OPTION
    ],
    request: (input) => {
      const path = { form_token: required(input, 'form') };
      const entry_field = required(input, 'field');
      const sms_template_id = required(input, 'template_id');
      if (estimating(input, 'Sending SMS')) {
        return call('estimateSmsTask', {
          path,
          query: {
            entry_field,
            ...narrowingQuery(input),
            select_all: selectAll(input),
            sms_template_id,
            placeholder_keys: placeholders(input)
          }
        });
      }
      return call('createSmsTask', {
        path,
        body: given({
          entry_field,
          ...narrowingBody(input),
          select_all: selectAll(input),
          sms_template_id,
          ...timing(input)
        })
      });
    },
    examples: [
      "jinshuju sms send --form Kp7mQ2 --field field_2 --template-id 6512a1c2d3e4f5a6b7c8d9e0 --filter 'field_5 eq 已报名' --estimate",
      "jinshuju sms send --form Kp7mQ2 --field field_2 --template-id 6512a1c2d3e4f5a6b7c8d9e0 --filter 'field_5 eq 已报名' --yes",
      'jinshuju sms send --form Kp7mQ2 --field field_2 --template-id 6512a1c2d3e4f5a6b7c8d9e0 --select-all ' +
        '--send-at 2026-10-24T09:00:00+08:00 --yes'
    ]
  },
  {
    path: ['sms', 'task', 'list'],
    summary: "List a form's SMS tasks, newest first, with how many numbers succeeded or failed so far",
    description: '--from and --to pick the tasks by the day they were created. A page holds at most 100 tasks.',
    options: [
      FORM_OPTION,
      {
        name: '--status',
        type: 'string',
        choices: choices('listSmsTasks', 'status'),
        placeholder: '<status>',
        description: 'Only the tasks in this status'
      },
      ...DAY_RANGE_OPTIONS,
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listSmsTasks', {
        path: { form_token: required(input, 'form') },
        query: { status: input.options.status as string | undefined, ...dayRange(input), ...paging(input) }
      }),
    paginate: LISTING,
    examples: [
      'jinshuju sms task list --form Kp7mQ2',
      'jinshuju sms task list --form Kp7mQ2 --status template_fail',
      'jinshuju sms task list --form Kp7mQ2 --from 2026-10-01 --to 2026-10-31'
    ]
  },
  {
    path: ['sms', 'task', 'get'],
    summary: 'Show an SMS task and how many numbers succeeded or failed so far',
    args: TASK_ARG,
    options: [FORM_OPTION],
    request: (input) => call('getSmsTask', { path: { form_token: required(input, 'form'), id: input.args.id } }),
    examples: ['jinshuju sms task get 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2']
  },
  {
    path: ['sms', 'task', 'activities'],
    summary: 'List the sending result of each number an SMS task sent to',
    args: TASK_ARG,
    options: [
      FORM_OPTION,
      {
        name: '--status',
        type: 'string',
        choices: choices('listSmsTaskActivities', 'status'),
        placeholder: '<status>',
        description: 'Only the numbers with this result; both when omitted'
      },
      { name: '--mobile', type: 'string', placeholder: '<mobile>', description: 'Only this number' },
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listSmsTaskActivities', {
        path: { form_token: required(input, 'form'), id: input.args.id },
        query: {
          status: input.options.status as string | undefined,
          mobile: input.options.mobile as string | undefined,
          ...paging(input)
        }
      }),
    paginate: LISTING,
    examples: ['jinshuju sms task activities 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --status FAILED']
  },
  {
    path: ['sms', 'task', 'revoke'],
    summary: 'Revoke an SMS task waiting to send or under content review, so it never sends',
    args: TASK_ARG,
    options: [FORM_OPTION],
    request: (input) =>
      call('updateSmsTask', {
        path: { form_token: required(input, 'form'), id: input.args.id },
        body: { revoked: true }
      }),
    examples: ['jinshuju sms task revoke 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2']
  },
  {
    path: ['sms', 'task', 'change'],
    summary: 'Change an SMS task whose template failed review, and send it again',
    description:
      'Only a task in template_fail. It keeps its entries and its id; --field and --placeholder left out keep what ' +
      'the task has. --estimate answers what it would bill with the new template and sends nothing; --yes sends.',
    args: TASK_ARG,
    options: [
      FORM_OPTION,
      TEMPLATE_ID_OPTION,
      { ...MOBILE_FIELD_OPTION, description: `${MOBILE_FIELD_OPTION.description}; the task's own when omitted` },
      ...TIMING_OPTIONS,
      ESTIMATE_OPTION,
      SEND_OPTION
    ],
    request: (input) => {
      const path = { form_token: required(input, 'form'), id: input.args.id };
      const sms_template_id = required(input, 'template_id');
      const entry_field = input.options.field as string | undefined;
      if (estimating(input, `Sending task ${input.args.id} again`)) {
        return call('estimateSmsTaskChange', {
          path,
          query: { entry_field, sms_template_id, placeholder_keys: placeholders(input) }
        });
      }
      return call('updateSmsTask', { path, body: given({ entry_field, sms_template_id, ...timing(input) }) });
    },
    examples: [
      'jinshuju sms task change 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --template-id 6512a1c2d3e4f5a6b7c8d9e1 --estimate',
      'jinshuju sms task change 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --template-id 6512a1c2d3e4f5a6b7c8d9e1 --yes'
    ]
  },
  {
    path: ['sms', 'task', 'send'],
    summary: 'Send an SMS task created with --manual',
    description: 'Once it has passed review. A task given a send time waits until then.',
    args: TASK_ARG,
    options: [FORM_OPTION, SEND_OPTION],
    request: (input) => {
      sendingConfirmed(input, `Sending task ${input.args.id}`);
      return call('sendSmsTask', { path: { form_token: required(input, 'form'), id: input.args.id } });
    },
    examples: ['jinshuju sms task send 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --yes']
  },
  {
    path: ['sms', 'task', 'resend'],
    summary: 'Send an SMS task again to the entries that got a result',
    description:
      'A new task, with the same template and variables, to the entries of this one that got --status: FAILED, ' +
      'SUCCESS or ALL. A filter, keyword or view narrows them further, and a serial_number none_in condition leaves ' +
      'some out. It sends at once. --estimate answers what it would send and bill and sends nothing; --yes sends.',
    args: TASK_ARG,
    options: [
      FORM_OPTION,
      {
        name: '--status',
        type: 'string',
        choices: bodyChoices('resendSmsTask', 'status'),
        placeholder: '<status>',
        description: 'Send again to the entries with this result; ALL for every one the task sent to'
      },
      ...NARROWING_OPTIONS,
      ESTIMATE_OPTION,
      SEND_OPTION
    ],
    request: (input) => {
      const path = { form_token: required(input, 'form'), id: input.args.id };
      const status = required(input, 'status');
      if (estimating(input, `Sending task ${input.args.id} again`)) {
        return call('estimateSmsTaskResend', { path, query: { status, ...narrowingQuery(input) } });
      }
      return call('resendSmsTask', { path, body: given({ status, ...narrowingBody(input) }) });
    },
    examples: [
      'jinshuju sms task resend 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --status FAILED --estimate',
      "jinshuju sms task resend 6716f2a8c1d2e3f4a5b6c7d9 --form Kp7mQ2 --status FAILED --filter 'serial_number none_in 3,8' --yes"
    ]
  }
];
