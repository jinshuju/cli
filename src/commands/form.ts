import {
  FILTER_OPTION,
  FILTERS_OPTION,
  JSON_OPTION,
  MINE_OPTION,
  PAGINATION_OPTIONS,
  SORT_OPTION,
  UsageError,
  type OptionSpec
} from '../options.js';
import {
  FOLDER_OPTION,
  LISTING,
  filters,
  given,
  keywords,
  overriding,
  paging,
  payload,
  refuseWithMine,
  requiredOption,
  sort
} from './shared.js';
import type { Command, CommandInput } from './types.js';
import { validateContainerPayload } from '../payload.js';
import { bodyChoices, call, type OperationId } from '../spec.js';
import { readableSize, upload, uploadedId, uploadFormImage } from './upload.js';
import { isRecord } from '../values.js';

/**
 * The shape behind `--json` on a form, shown rather than described: `fields` is
 * the part nothing else hints at, and one choice field carries more of the
 * grammar than a paragraph would. What `type` may be, and what each type takes
 * beyond this, is `field types`.
 */
const FORM_PAYLOAD: readonly string[] = [
  '{',
  '  "name": "Event signup",',
  '  "description": "optional",',
  '  "fields": [',
  '    { "type": "TextField",   "label": "Name",   "required": true },',
  '    { "type": "RadioButton", "label": "Ticket", "choices": [',
  '        { "name": "Standard" }, { "name": "VIP" } ] }',
  '  ],',
  '  "setting": {',
  '    "by_time_range_close_rule": { "start_time": "2026-10-01T09:00:00+08:00",',
  '                                  "end_time":   "2026-10-07T18:00:00+08:00" },',
  '    "daily_repeat_close_rule": { "time_periods": [',
  '        { "start_time": { "hour": 11, "minute": 0 }, "end_time": { "hour": 12, "minute": 40 } } ] },',
  '    "show_close_count_down": true',
  '  }',
  '}',
  '',
  'A choice carries "name". The "value" it reads back with is the code the',
  'backend assigns, not what you sent.',
  '',
  '"setting" is optional and travels as is. When the form takes entries is its',
  'close rules: by_time_range_close_rule opens it between two instants (either',
  'may be left out), daily_repeat_close_rule opens it inside time-of-day periods',
  'every day, by_entries_close_rule {"limit": 100} closes it after that many',
  'entries, and manually_close_rule {"closed": true} stops it now. The rules',
  'coexist. show_form_before_open and show_close_count_down only hold with a',
  'time-range or daily rule. The same keys go in a `form edit` payload, where',
  'time_periods replaces the list and {"enabled": false} or null removes a',
  'time-range, daily or entries rule. {"closed": false} reopens the form, and',
  'changing "closed" either way deletes the other three rules.',
  '',
  'setting.wording renames what the fill page says: "submit" is the submit',
  "button's text, and its other keys the start button and the password, closed,",
  'not-open and fill-limit messages. A key left out keeps its text, and ""',
  'puts the default back.',
  '',
  'Reading a form back does not give you something you can send again: a field',
  'written as "TextField" reads as "single_line_text". `field types` lists the',
  'names to write, and `field types <Type>` describes one.',
  '',
  'Field types: jinshuju field types'
];

/**
 * What `form get --include` accepts, and the parameter each one asks for. The
 * names are the CLI's — short, and about the thing rather than about the flag
 * that fetches it.
 */
const FORM_INCLUDES: Record<string, string> = {
  // `setting` is in the design and already part of the payload, so asking for
  // it is honoured by there being nothing to fetch. It is listed so the help
  // matches what the flag accepts.
  setting: '',
  theme: 'include_theme',
  rules: 'include_field_rules',
  extended: 'include_extended_attributes',
  transactions: 'include_transactions',
  analytics: 'include_analytics',
  // An exam form's exam settings, under the key `form edit` writes them by;
  // any other form carries nothing for it. The one name here that is the key
  // itself: `exam` alone reads as the scene, and this list already has
  // `setting`, which it sits beside. An OAuth token needs the form_setting
  // scope, which the CLI's own login asks for.
  exam_setting: 'include_exam_setting'
};

const INCLUDE_OPTION: OptionSpec = {
  name: '--include',
  type: 'list',
  placeholder: Object.keys(FORM_INCLUDES).join(','),
  description: `Extra blocks to carry: ${Object.keys(FORM_INCLUDES).join(', ')}. The setting is always there`
};

function includes(input: CommandInput): Record<string, boolean> {
  const asked = (input.options.include as string[] | undefined) ?? [];
  const query: Record<string, boolean> = {};
  for (const name of asked) {
    const parameter = FORM_INCLUDES[name];
    if (parameter === '') continue;
    if (!parameter) {
      throw new UsageError(`--include takes ${Object.keys(FORM_INCLUDES).join(', ')}, got ${JSON.stringify(name)}`);
    }
    query[parameter] = true;
  }
  return query;
}

/**
 * What `form wheel-fortune edit --json` takes, shown rather than described: a
 * gift and a voucher prize side by side carry most of what the shape asks.
 */
const WHEEL_FORTUNE_PAYLOAD: readonly string[] = [
  '{',
  '  "enabled": true,',
  '  "prizes": [',
  '    { "title": "一等奖", "prize_name": "蓝牙耳机", "probability": 5, "prize_amount": 10 },',
  '    { "title": "二等奖", "prize_name": "咖啡券", "probability": 20, "prize_type": "voucher",',
  '      "vouchers": [ { "code": "00123" }, { "code": "00124", "password": "p1" } ] }',
  '  ],',
  '  "lottery": { "limit_times": 1, "show_casher": false },',
  '  "cash": { "cash_style": "code" },',
  '  "text": { "win_text": "恭喜抽中 $(奖品名称)", "lose_text": "谢谢参与",',
  '            "cash_text": "凭兑奖码到前台领取" }',
  '}',
  '',
  'Only the keys present are written, but "prizes" replaces the list as a whole:',
  'pass each prize to keep back with its "id" from `form wheel-fortune get`, or it',
  'goes with its winners. A voucher prize hands each winner one of its codes, and',
  'takes them only when it is added. "cash" cannot be changed once saved.',
  '',
  'The lucky wheel is a paid add-on. "confirm_form_app_trial": true starts the',
  "account's free trial, once per account, so ask its owner first. Turning the",
  'wheel on while the form ends with something else — a redirect, an exam score,',
  'a red envelope — is refused until "confirm_ending_conflicts": true, which',
  'switches the ending to a message as the editor does.',
  '',
  'A "phone" cash and "send_sms" name a mobile field by its api_code:',
  'jinshuju field list --form <token>'
];

const PRIZE_IMAGE_OPTION: OptionSpec = {
  name: '--prize-image',
  type: 'string',
  repeatable: true,
  placeholder: '<title>=<file>',
  description: 'Upload an image for the prize of this title in the payload, repeatable'
};

/** How a flag ties files to the items of a payload list, each given as `<name>=<file>`. */
interface NamedFiles {
  flag: string;
  values: readonly string[];
  items: readonly unknown[];
  key: string;
  noun: string;
  maxMegabytes?: number;
}

interface NamedFile {
  item: Record<string, unknown>;
  file: string;
}

/**
 * The files a flag ties to items of a payload list by one of their keys: a
 * lucky wheel's prizes by title, a quick payment form's deliverables by name,
 * which a caller can read off what they wrote. Every name is matched and every
 * file found readable, and within `maxMegabytes` when given, before the first
 * goes up: once one is uploaded, a failure on the next leaves it behind, and
 * running the command again sends it a second time.
 */
function namedFiles({ flag, values, items, key, noun, maxMegabytes }: NamedFiles): NamedFile[] {
  const names = items.filter(isRecord).map((candidate) => candidate[key]);
  const named = new Set<string>();
  return values.map((value) => {
    const at = nameEnd(flag, value, names);
    const name = value.slice(0, at);
    const file = value.slice(at + 1);
    if (at <= 0 || !file) throw new UsageError(`${flag} must be '<${key}>=<file>', got ${JSON.stringify(value)}`);
    if (named.has(name)) throw new UsageError(`${flag} names ${JSON.stringify(name)} twice`);
    named.add(name);
    const matching = items.filter((candidate) => isRecord(candidate) && candidate[key] === name);
    if (matching.length === 0) {
      throw new UsageError(`${flag} names ${JSON.stringify(name)}, but no ${noun} in the payload has that ${key}`);
    }
    if (matching.length > 1) {
      throw new UsageError(`${flag} names ${JSON.stringify(name)}, which ${matching.length} ${noun}s share`);
    }
    const size = readableSize(file);
    if (maxMegabytes !== undefined && size > maxMegabytes * 1024 * 1024) {
      throw new UsageError(`${file} is over ${maxMegabytes} MB`);
    }
    return { item: matching[0] as Record<string, unknown>, file };
  });
}

/**
 * Where `<name>=<file>` splits. A name and a path may each hold a `=`, so it is
 * at the `=` whose left side is one of the names, or the first when none is.
 */
function nameEnd(flag: string, value: string, names: readonly unknown[]): number {
  const ends: number[] = [];
  for (let at = value.indexOf('='); at !== -1; at = value.indexOf('=', at + 1)) {
    if (names.includes(value.slice(0, at))) ends.push(at);
  }
  if (ends.length > 1) {
    const which = ends.map((at) => JSON.stringify(value.slice(0, at))).join(' or ');
    throw new UsageError(`${flag} ${JSON.stringify(value)} could name ${which}`);
  }
  return ends[0] ?? value.indexOf('=');
}

/** Files to upload onto items under `key`, and the save that sends the items after. */
interface UploadThenSave<T> {
  targets: readonly NamedFile[];
  key: string;
  upload: (file: string) => Promise<string>;
  what: string;
  save: () => Promise<T>;
}

/**
 * Uploads each file and sets its id on its item, then saves. A failure after a
 * file went up says which did and the id each went up as: an uploaded file
 * stays, and a second run that puts its id in the payload need not upload it
 * again.
 */
async function uploadThenSave<T>({ targets, key, upload, what, save }: UploadThenSave<T>): Promise<T> {
  const uploaded: string[] = [];
  let step = '';
  try {
    for (const { item, file } of targets) {
      step = `uploading ${file}`;
      item[key] = await upload(file);
      uploaded.push(`${file} as ${key} ${item[key] as string}`);
    }
    step = `saving ${what}`;
    return await save();
  } catch (error) {
    if (uploaded.length === 0) throw error;
    throw new Error(
      `uploaded ${uploaded.join(', ')}, but ${step} failed: ${(error as Error).message}. ` +
        'Put each id in the payload to run again without uploading its file again.',
      { cause: error }
    );
  }
}

/**
 * What `form quickpay edit --json` takes, shown rather than described: a link
 * and a file deliverable side by side carry most of what the shape asks.
 */
const QUICKPAY_PAYLOAD: readonly string[] = [
  '{',
  '  "mode": "choice",',
  '  "auto_delivery_enabled": true,',
  '  "deliverables": [',
  '    { "kind": "link", "name": "下载地址", "url": "https://example.com/book",',
  '      "goods_item_api_codes": ["early"] },',
  '    { "kind": "file", "name": "电子书", "goods_item_api_codes": ["early", "full"] }',
  '  ]',
  '}',
  '',
  'Only the keys present are written, but "deliverables" replaces those of the',
  'goods field buyers see under the mode as a whole: pass each one to keep back',
  'with its "token" from `form quickpay get`. A file or image deliverable takes',
  'an "attachment_id"; --deliverable-file uploads a file and sets it on the',
  'deliverable of that name. While auto_delivery_enabled is on, buyers get the',
  'deliverables of the tier they paid for once they pay.',
  '',
  'mode is fixed for one price, choice for buyers to pick a tier, custom for them',
  'to enter the amount, and the goods field has to fit it. A tier is named by the',
  '"value" of one of the goods field\'s goods_items:',
  'jinshuju field list --form <token>'
];

const DELIVERABLE_FILE_OPTION: OptionSpec = {
  name: '--deliverable-file',
  type: 'string',
  repeatable: true,
  placeholder: '<name>=<file>',
  description: 'Upload a file for the deliverable of this name in the payload, repeatable'
};

function themeBody(input: CommandInput): Record<string, unknown> {
  const rest = (input.options.json as Record<string, unknown> | undefined) ?? {};
  return overriding(rest, {
    primary_color: input.options.primary_color,
    secondary_color: input.options.secondary_color
  });
}

/** The scenes a form can be created for, as the API names them. */
const FORM_SCENES = bodyChoices('createForm', 'scene');

/**
 * A form's type picks both the scene it is created in and the settings block
 * that belongs to it. Those settings live behind their own endpoint, so a
 * payload carrying one is two requests, not one — and a generic edit would
 * drop the block on the floor, since the form update only reads name,
 * description, setting, fields and field_rules.
 */
const FORM_TYPES: Record<string, { scene?: string; settingKey?: string; operation?: OperationId }> = {
  normal: {},
  exam: { scene: 'exam', settingKey: 'exam_setting', operation: 'updateExamSetting' },
  evaluation: { scene: 'evaluation', settingKey: 'evaluation_setting', operation: 'updateEvaluationSetting' }
};

type SettingsBlock = { key: string; operation: OperationId; value: unknown };

/** Which settings block a payload carries, and which operation it has to be sent to. */
function settingsBlock(body: Record<string, unknown>): SettingsBlock | undefined {
  for (const { settingKey, operation } of Object.values(FORM_TYPES)) {
    if (settingKey && operation && body[settingKey] !== undefined) {
      return { key: settingKey, operation, value: body[settingKey] };
    }
  }
  return undefined;
}

/** A settings block, sent to the form it belongs to. */
function saveSettings(form: string, settings: SettingsBlock) {
  return call(settings.operation, { path: { form_token: form }, body: settings.value });
}

/** The scene a --type implies, refusing a --scene that contradicts it. */
function sceneFor(input: CommandInput): string | undefined {
  const type = (input.options.type as string | undefined) ?? 'normal';
  const scene = input.options.scene as string | undefined;
  const implied = FORM_TYPES[type]?.scene;
  if (implied && scene && scene !== implied) {
    throw new UsageError(`--type ${type} is the ${implied} scene, so --scene ${scene} contradicts it`);
  }
  return implied ?? scene;
}

function createFormBody(input: CommandInput): { body: Record<string, unknown>; settings?: SettingsBlock } {
  const payloadBody = { ...validateContainerPayload(payload(input), 'form') };
  const settings = settingsBlock(payloadBody);
  if (settings) delete payloadBody[settings.key];

  return {
    body: overriding(payloadBody, {
      scene: sceneFor(input),
      layout: input.options.layout,
      folder_token: input.options.folder
    }),
    settings
  };
}

export const FORM: readonly Command[] = [
  {
    path: ['form', 'list'],
    summary: 'List forms',
    description: 'Filters act on the form itself: form_name, created_at, last_entry_created_at, entries_count.',
    options: [
      {
        name: '--name',
        type: 'string',
        repeatable: true,
        placeholder: '<kw>',
        description: 'Match forms whose name contains the keyword, repeatable'
      },
      { name: '--with-transactions', type: 'boolean', description: "Carry each payment form's collected totals" },
      MINE_OPTION,
      FILTER_OPTION,
      FILTERS_OPTION,
      SORT_OPTION,
      ...PAGINATION_OPTIONS
    ],
    request: (input) => {
      if (input.options.mine) {
        refuseWithMine(input, ['name', 'with_transactions', 'filter', 'filters', 'sort']);
        return call('listMyFilledForms', { query: paging(input) });
      }
      return call('listForms', {
        query: {
          q: keywords(input.options.name),
          include_transactions: input.options.with_transactions ? true : undefined,
          filters: filters(input),
          sort: sort(input, 'field'),
          ...paging(input)
        }
      });
    },
    paginate: LISTING,
    examples: [
      'jinshuju form list --name 报名',
      'jinshuju form list --sort entries_count:desc --limit 10',
      'jinshuju form list --mine'
    ]
  },
  {
    path: ['form', 'get'],
    summary: 'Show a form: fields, types, choices',
    description:
      'The form carries its setting already. --include adds the blocks that are separate reads ' +
      'otherwise, so asking for a form and its rules is one round trip. analytics says which ' +
      'statistics each field takes, which is what the analysis reads validate against. ' +
      "exam_setting is an exam form's, read back in the shape `form edit` writes it. `fields` " +
      'comes back as a list of one-key objects keyed by api_code, not a flat list — `field list` ' +
      'answers the same fields flattened, with api_code on each.',
    args: [{ name: 'form', required: true, description: 'Form token, six letters and digits, e.g. Kp7mQ2' }],
    options: [INCLUDE_OPTION],
    request: (input) => call('getForm', { path: { form_token: input.args.form }, query: includes(input) }),
    examples: [
      'jinshuju form get Kp7mQ2',
      'jinshuju form get Kp7mQ2 --include theme,rules,analytics',
      'jinshuju form get Kp7mQ2 --include exam_setting'
    ]
  },
  {
    path: ['form', 'create'],
    summary: 'Create a form',
    description:
      'Field types use the API v1 names. Run `jinshuju field types` for the full list and what each ' +
      'one accepts. Do not pass api_code: the backend generates it. The scene decides what kind of ' +
      'form it is — an exam scores its answers, a reservation holds slots — and the card layout ' +
      'refuses the field types it cannot show.',
    payload: FORM_PAYLOAD,
    options: [
      JSON_OPTION,
      {
        name: '--type',
        type: 'string',
        choices: Object.keys(FORM_TYPES),
        placeholder: '<type>',
        description:
          'normal, exam or evaluation. An exam or evaluation also takes its own settings block in the payload'
      },
      {
        name: '--scene',
        type: 'string',
        choices: FORM_SCENES,
        placeholder: '<scene>',
        description: FORM_SCENES ? `What the form is for: ${FORM_SCENES.join(', ')}` : 'What the form is for'
      },
      {
        name: '--layout',
        type: 'string',
        choices: bodyChoices('createForm', 'layout'),
        placeholder: '<layout>',
        description: 'classic shows every field at once, card one page at a time'
      },
      FOLDER_OPTION
    ],
    run: async (input, client) => {
      const { body, settings } = createFormBody(input);
      if (!settings) return client.request(call('createForm', { body }));

      // The settings can only be sent to a form that exists, but what they
      // would be refused for here can be said before one is made.
      client.check?.(saveSettings('new', settings));
      const form = await client.request<{ token: string }>(call('createForm', { body }));
      try {
        await client.request(saveSettings(form.token, settings));
      } catch (error) {
        // The form exists; saying so beats an error that reads as though
        // nothing happened and inviting a second one to be created.
        throw new Error(
          `form ${form.token} was created, but its ${settings.key} was refused: ` +
            `${(error as Error).message}. Fix it and apply with \`form edit\`.`,
          { cause: error }
        );
      }
      return client.request(call('getForm', { path: { form_token: form.token } }));
    },
    examples: [
      'jinshuju form create --json @form.json',
      'jinshuju form create --json @exam.json --type exam',
      'cat form.json | jinshuju form create --json -'
    ]
  },
  {
    path: ['form', 'edit'],
    summary: 'Edit a form',
    description:
      'The payload carries the operations to apply: name, description, setting, and fields as ' +
      '{add, update, update_choices, remove}. Only what is named changes. `form create --help` ' +
      'shows what setting takes, the close rules among it.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [JSON_OPTION],
    run: async (input, client) => {
      const form = input.args.form as string;
      const body = { ...(payload(input) as Record<string, unknown>) };
      const settings = settingsBlock(body);
      if (!settings) return client.request(call('updateForm', { path: { form_token: form }, body }));

      delete body[settings.key];
      // The settings go first: they are the half that can be refused for what
      // the form is, so leading with them is what keeps a refusal from landing
      // after the rest was already written. What the rest would be refused for
      // here is said before either goes.
      if (Object.keys(body).length > 0) client.check?.(call('updateForm', { path: { form_token: form }, body }));
      await client.request(saveSettings(form, settings));
      if (Object.keys(body).length === 0) return client.request(call('getForm', { path: { form_token: form } }));

      try {
        return await client.request(call('updateForm', { path: { form_token: form }, body }));
      } catch (error) {
        // Ordering cannot make two requests atomic; it only chooses which half
        // fails first. When the second one fails the first has landed, and an
        // error that reads as though nothing happened would invite the whole
        // edit to be sent again.
        throw new Error(
          `${settings.key} was saved, but the rest of the edit (${Object.keys(body).join(', ')}) ` +
            `was refused: ${(error as Error).message}. Re-send only what failed.`,
          { cause: error }
        );
      }
    },
    examples: [
      'jinshuju form edit Kp7mQ2 --json \'{"name":"2026 活动报名"}\'',
      'jinshuju form edit Kp7mQ2 --json \'{"setting":{"daily_repeat_close_rule":{"time_periods":[{"start_time":{"hour":11,"minute":0},"end_time":{"hour":12,"minute":40}}]}}}\'',
      'jinshuju form edit Kp7mQ2 --json \'{"setting":{"wording":{"submit":"立即报名"}}}\'',
      'jinshuju form edit Kp7mQ2 --json \'{"exam_setting":{"limited_time":30}}\''
    ]
  },
  {
    path: ['form', 'copy'],
    summary: 'Copy a form',
    args: [{ name: 'form', required: true, description: 'Form token to copy' }],
    options: [
      { name: '--name', type: 'string', placeholder: '<name>', description: 'Name for the copy' },
      FOLDER_OPTION,
      {
        name: '--with-notification-rules',
        type: 'boolean',
        description: 'Also copy the notification rules; needs manage permission on the form'
      }
    ],
    request: (input) =>
      call('copyForm', {
        path: { form_token: input.args.form },
        body: given({
          name: input.options.name,
          folder_token: input.options.folder,
          with_notification_rules: input.options.with_notification_rules ? true : undefined
        })
      })
  },
  {
    path: ['form', 'move'],
    summary: 'Move a form into a folder, or out of one',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [FOLDER_OPTION],
    request: (input) =>
      call('moveFormToFolder', {
        path: { form_token: input.args.form },
        body: { folder_token: (input.options.folder as string | undefined) ?? '' }
      }),
    examples: ['jinshuju form move Kp7mQ2 --folder Fd2xK8', 'jinshuju form move Kp7mQ2']
  },
  {
    path: ['form', 'theme', 'set'],
    summary: "Set a form's theme",
    description:
      'The colours have flags of their own, and --wallpaper and --header each upload an image and ' +
      'bind it to the theme in one command. Everything else the theme takes — typography, ' +
      'form_container, submit_button — goes through --json.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [
      { name: '--primary-color', type: 'string', placeholder: '<hex>', description: 'Primary colour, e.g. #1F6FEB' },
      { name: '--secondary-color', type: 'string', placeholder: '<hex>', description: 'Secondary colour' },
      {
        name: '--wallpaper',
        type: 'string',
        placeholder: '<file>',
        description: 'Image file to use as the background'
      },
      { name: '--header', type: 'string', placeholder: '<file>', description: 'Image file to use as the header' },
      JSON_OPTION
    ],
    run: async (input, client) => {
      const wallpaper = input.options.wallpaper as string | undefined;
      const header = input.options.header as string | undefined;
      const path = { form_token: input.args.form as string };
      if (!wallpaper && !header) return client.request(call('updateFormTheme', { path, body: themeBody(input) }));

      const body = themeBody(input) as Record<string, Record<string, unknown>>;
      if (wallpaper) {
        const image = await uploadFormImage(client, wallpaper, 'wallpaper');
        body.wallpaper = { ...body.wallpaper, background_image_attachment_id: image };
      }
      if (header) {
        const image = await uploadFormImage(client, header, 'header');
        body.header = { ...body.header, header_image_attachment_id: image };
      }
      return client.request(call('updateFormTheme', { path, body }));
    },
    examples: [
      'jinshuju form theme set Kp7mQ2 --primary-color "#1F6FEB"',
      'jinshuju form theme set Kp7mQ2 --wallpaper ./bg.png'
    ]
  },
  {
    path: ['form', 'image', 'upload'],
    summary: 'Upload an image for a form or field description',
    description:
      "Answers with a url to put in an <img src> inside a form's description or a field's notes. " +
      'The image belongs to the first form saved with a description that refers to it; one that no ' +
      'form takes within 7 days is removed.',
    args: [{ name: 'file', required: true, description: 'Image file' }],
    request: (input) => upload('uploadFormImage', {}, input.args.file as string, { image_type: 'description' }),
    examples: ['jinshuju form image upload ./venue-map.png']
  },
  {
    path: ['form', 'rule', 'get'],
    summary: 'Show the field display rules of a form',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    request: (input) => call('listFieldRules', { path: { form_token: input.args.form } })
  },
  {
    path: ['form', 'rule', 'edit'],
    summary: 'Edit the field display rules of a form',
    description: 'The payload is {add, update, remove}; a rule is targeted by the index `form rule get` shows.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [JSON_OPTION],
    request: (input) =>
      call('updateForm', { path: { form_token: input.args.form }, body: { field_rules: payload(input) } })
  },
  {
    path: ['form', 'wheel-fortune', 'get'],
    summary: "Show a form's lucky wheel: prizes, draws, how winners redeem",
    description:
      'The prize ids are what `form wheel-fortune edit` passes back to keep a prize and its ' +
      'winners, and what `form wheel-fortune export-vouchers --prize` takes. An account that has ' +
      'neither bought nor tried the lucky wheel is answered 402, saying how to start its trial.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    request: (input) => call('getWheelFortune', { path: { form_token: input.args.form } }),
    examples: ['jinshuju form wheel-fortune get Kp7mQ2']
  },
  {
    path: ['form', 'wheel-fortune', 'edit'],
    summary: "Set up a form's lucky wheel and turn it on or off",
    description:
      'Respondents go to the wheel after submitting once it is on. --prize-image uploads an image ' +
      "and sets it on the payload's prize of that title in one command.",
    payload: WHEEL_FORTUNE_PAYLOAD,
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [
      JSON_OPTION,
      { name: '--enable', type: 'boolean', description: 'Turn the lucky wheel on' },
      { name: '--disable', type: 'boolean', description: 'Turn the lucky wheel off' },
      PRIZE_IMAGE_OPTION
    ],
    run: async (input, client) => {
      if (input.options.enable && input.options.disable) {
        throw new UsageError('--enable and --disable are opposites, pass one');
      }
      const json = input.options.json;
      if (json !== undefined && !isRecord(json)) throw new UsageError('--json must be a JSON object');
      const path = { form_token: input.args.form as string };
      const enabled = input.options.enable ? true : input.options.disable ? false : undefined;
      const body = overriding(json ?? {}, { enabled });
      const images = (input.options.prize_image as string[] | undefined) ?? [];
      if (images.length === 0) return client.request(call('updateWheelFortune', { path, body }));

      const prizes = Array.isArray(body.prizes)
        ? body.prizes.map((prize: unknown) => (isRecord(prize) ? { ...prize } : prize))
        : [];
      const targets = namedFiles({ flag: '--prize-image', values: images, items: prizes, key: 'title', noun: 'prize' });
      // What the setup would be refused for is said before an image goes up for it.
      client.check?.(call('updateWheelFortune', { path, body: { ...body, prizes } }));
      return uploadThenSave({
        targets,
        key: 'prize_image_id',
        upload: (file) => uploadFormImage(client, file, 'wheel_fortune_prize'),
        what: 'the lucky wheel',
        save: () => client.request(call('updateWheelFortune', { path, body: { ...body, prizes } }))
      });
    },
    examples: [
      'jinshuju form wheel-fortune edit Kp7mQ2 --json @wheel.json --prize-image 一等奖=./earbuds.png',
      'jinshuju form wheel-fortune edit Kp7mQ2 --disable',
      'jinshuju form wheel-fortune edit Kp7mQ2 --json \'{"confirm_form_app_trial":true,"lottery":{"limit_times":3,"show_casher":false}}\''
    ]
  },
  {
    path: ['form', 'wheel-fortune', 'export-vouchers'],
    summary: 'Export the vouchers a prize has not handed out yet',
    description: 'Answers with a link to an Excel file of the codes, and how many there are.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [
      {
        name: '--prize',
        type: 'string',
        placeholder: '<id>',
        description: 'Voucher prize id, from `form wheel-fortune get`'
      }
    ],
    request: (input) =>
      call('exportRemainingVouchers', {
        path: { form_token: input.args.form, prize_id: requiredOption(input, 'prize') }
      }),
    examples: ['jinshuju form wheel-fortune export-vouchers Kp7mQ2 --prize 6af1381d114fae12e40e44ea']
  },
  {
    path: ['form', 'quickpay', 'get'],
    summary: "Show a quick payment form's payment mode, and what buyers get once they pay",
    description:
      'goods_field_api_code is the goods field buyers see under the mode, and only its deliverables are ' +
      "handed out. A deliverable's token is what `form quickpay edit` passes back to keep it. Quick " +
      'payment forms only.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    request: (input) => call('getQuickpaySetting', { path: { form_token: input.args.form } }),
    examples: ['jinshuju form quickpay get Kp7mQ2']
  },
  {
    path: ['form', 'quickpay', 'edit'],
    summary: "Set a quick payment form's payment mode, and what buyers get once they pay",
    description:
      "--deliverable-file uploads a file of up to 200 MB and sets it on the payload's deliverable of " +
      'that name in one command. An upload has the one-minute deadline of every request; give a large ' +
      'file on a slow line longer with JINSHUJU_TIMEOUT_MS.',
    payload: QUICKPAY_PAYLOAD,
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [JSON_OPTION, DELIVERABLE_FILE_OPTION],
    run: async (input, client) => {
      const json = payload(input);
      if (!isRecord(json)) throw new UsageError('--json must be a JSON object');
      const path = { form_token: input.args.form as string };
      const body = { ...json };
      const files = (input.options.deliverable_file as string[] | undefined) ?? [];
      if (files.length === 0) return client.request(call('updateQuickpaySetting', { path, body }));

      const deliverables = Array.isArray(body.deliverables)
        ? body.deliverables.map((deliverable: unknown) => (isRecord(deliverable) ? { ...deliverable } : deliverable))
        : [];
      const targets = namedFiles({
        flag: '--deliverable-file',
        values: files,
        items: deliverables,
        key: 'name',
        noun: 'deliverable',
        maxMegabytes: 200
      });
      // What the settings would be refused for is said before a file goes up for them.
      client.check?.(call('updateQuickpaySetting', { path, body: { ...body, deliverables } }));
      return uploadThenSave({
        targets,
        key: 'attachment_id',
        upload: (file) => uploadedId(client, { id: 'uploadGoodsDeliverableAttachment', path, file, key: 'id' }),
        what: 'the quick payment settings',
        save: () => client.request(call('updateQuickpaySetting', { path, body: { ...body, deliverables } }))
      });
    },
    examples: [
      'jinshuju form quickpay edit Kp7mQ2 --json @quickpay.json --deliverable-file 电子书=./book.pdf',
      'jinshuju form quickpay edit Kp7mQ2 --json \'{"auto_delivery_enabled":false}\'',
      'jinshuju form quickpay edit Kp7mQ2 --json \'{"mode":"fixed"}\''
    ]
  },
  {
    path: ['form', 'cooperator', 'list'],
    summary: 'List the cooperators of a form',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    request: (input) => call('listFormCooperators', { path: { form_token: input.args.form } })
  }
];
