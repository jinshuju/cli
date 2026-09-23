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
  API,
  FOLDER_OPTION,
  LISTING,
  filters,
  given,
  keywords,
  overriding,
  paging,
  payload,
  refuseWithMine,
  sort
} from './shared.js';
import type { Command, CommandInput } from './types.js';
import { validateContainerPayload } from '../payload.js';
import { progress } from '../progress.js';
import type { HttpClient } from '../http.js';
import { basename } from 'node:path';
import { upload } from './upload.js';

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
  '  ]',
  '}',
  '',
  'A choice carries "name". The "value" it reads back with is the code the',
  'backend assigns, not what you sent.',
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
  analytics: 'include_analytics'
};

const INCLUDE_OPTION: OptionSpec = {
  name: '--include',
  type: 'list',
  placeholder: Object.keys(FORM_INCLUDES).join(','),
  description: `Extra blocks to carry: ${Object.keys(FORM_INCLUDES).join(', ')}. The setting is always there`
};

function includes(input: CommandInput): Record<string, string | undefined> {
  const asked = (input.options.include as string[] | undefined) ?? [];
  const query: Record<string, string | undefined> = {};
  for (const name of asked) {
    const parameter = FORM_INCLUDES[name];
    if (parameter === '') continue;
    if (!parameter) {
      throw new UsageError(`--include takes ${Object.keys(FORM_INCLUDES).join(', ')}, got ${JSON.stringify(name)}`);
    }
    query[parameter] = 'true';
  }
  return query;
}

function themeBody(input: CommandInput): Record<string, unknown> {
  const rest = (input.options.json as Record<string, unknown> | undefined) ?? {};
  return overriding(rest, {
    primary_color: input.options.primary_color,
    secondary_color: input.options.secondary_color
  });
}

async function uploadImage(client: HttpClient, file: string, imageType: string): Promise<string> {
  const watching = progress();
  watching.step(`uploading ${basename(file)}…`);
  try {
    const uploaded = await client.request<{ attachment_id: string }>(
      upload(`${API}/form_image_attachments`, file, { image_type: imageType })
    );
    return uploaded.attachment_id;
  } finally {
    watching.done();
  }
}

/** The scenes a form can be created for, as the API names them. */
const FORM_SCENES = [
  'survey',
  'registry',
  'vote',
  'exam',
  'reservation',
  'customer_acquisition',
  'evaluation',
  'online_payment'
] as const;

/**
 * A form's type picks both the scene it is created in and the settings block
 * that belongs to it. Those settings live behind their own endpoint, so a
 * payload carrying one is two requests, not one — and a generic edit would
 * drop the block on the floor, since the form update only reads name,
 * description, setting, fields and field_rules.
 */
const FORM_TYPES: Record<string, { scene?: string; settingKey?: string; path?: string }> = {
  normal: {},
  exam: { scene: 'exam', settingKey: 'exam_setting', path: 'exam_setting' },
  evaluation: { scene: 'evaluation', settingKey: 'evaluation_setting', path: 'evaluation_setting' }
};

/** Which settings block a payload carries, and where it has to be sent. */
function settingsBlock(body: Record<string, unknown>): { key: string; path: string; value: unknown } | undefined {
  for (const { settingKey, path } of Object.values(FORM_TYPES)) {
    if (settingKey && path && body[settingKey] !== undefined) {
      return { key: settingKey, path, value: body[settingKey] };
    }
  }
  return undefined;
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

function createFormBody(input: CommandInput): {
  body: Record<string, unknown>;
  settings?: { key: string; path: string; value: unknown };
} {
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
        return { method: 'GET', path: `${API}/my/forms`, query: paging(input) };
      }
      return {
        method: 'GET',
        path: `${API}/forms`,
        query: {
          q: keywords(input.options.name),
          include_transactions: input.options.with_transactions ? 'true' : undefined,
          filters: filters(input),
          sort: sort(input, 'field'),
          ...paging(input)
        }
      };
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
      'statistics each field takes, which is what the analysis reads validate against. `fields` ' +
      'comes back as a list of one-key objects keyed by api_code, not a flat list — `field list` ' +
      'answers the same fields flattened, with api_code on each.',
    args: [{ name: 'form', required: true, description: 'Form token, six letters and digits, e.g. Kp7mQ2' }],
    options: [INCLUDE_OPTION],
    request: (input) => ({
      method: 'GET',
      path: `${API}/forms/${input.args.form}`,
      query: includes(input)
    }),
    examples: ['jinshuju form get Kp7mQ2', 'jinshuju form get Kp7mQ2 --include theme,rules,analytics']
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
        description: `What the form is for: ${FORM_SCENES.join(', ')}`
      },
      {
        name: '--layout',
        type: 'string',
        choices: ['classic', 'card'],
        placeholder: '<layout>',
        description: 'classic shows every field at once, card one page at a time'
      },
      FOLDER_OPTION
    ],
    run: async (input, client) => {
      const { body, settings } = createFormBody(input);
      if (!settings) return client.request({ method: 'POST', path: `${API}/forms`, body });

      const form = await client.request<{ token: string }>({ method: 'POST', path: `${API}/forms`, body });
      try {
        await client.request({
          method: 'PATCH',
          path: `${API}/forms/${form.token}/${settings.path}`,
          body: settings.value
        });
      } catch (error) {
        // The form exists; saying so beats an error that reads as though
        // nothing happened and inviting a second one to be created.
        throw new Error(
          `form ${form.token} was created, but its ${settings.key} was refused: ` +
            `${(error as Error).message}. Fix it and apply with \`form edit\`.`,
          { cause: error }
        );
      }
      return client.request({ method: 'GET', path: `${API}/forms/${form.token}` });
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
      '{add, update, update_choices, remove}. Only what is named changes.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [JSON_OPTION],
    run: async (input, client) => {
      const body = { ...(payload(input) as Record<string, unknown>) };
      const settings = settingsBlock(body);
      if (!settings) return client.request({ method: 'PATCH', path: `${API}/forms/${input.args.form}`, body });

      delete body[settings.key];
      // The settings go first: they are the half that can be refused for what
      // the form is, so leading with them is what keeps a refusal from landing
      // after the rest was already written.
      await client.request({
        method: 'PATCH',
        path: `${API}/forms/${input.args.form}/${settings.path}`,
        body: settings.value
      });
      if (Object.keys(body).length === 0)
        return client.request({ method: 'GET', path: `${API}/forms/${input.args.form}` });

      try {
        return await client.request({ method: 'PATCH', path: `${API}/forms/${input.args.form}`, body });
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
      'jinshuju form edit Kp7mQ2 --json \'{"exam_setting":{"total_score":100}}\''
    ]
  },
  {
    path: ['form', 'copy'],
    summary: 'Copy a form',
    args: [{ name: 'form', required: true, description: 'Form token to copy' }],
    options: [
      { name: '--name', type: 'string', placeholder: '<name>', description: 'Name for the copy' },
      FOLDER_OPTION
    ],
    request: (input) => ({
      method: 'POST',
      path: `${API}/forms/${input.args.form}/copy`,
      body: given({ name: input.options.name, folder_token: input.options.folder })
    })
  },
  {
    path: ['form', 'move'],
    summary: 'Move a form into a folder, or out of one',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [FOLDER_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: `${API}/forms/${input.args.form}/folder`,
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
      const path = `${API}/forms/${input.args.form}/theme`;
      if (!wallpaper && !header) return client.request({ method: 'PATCH', path, body: themeBody(input) });

      const body = themeBody(input) as Record<string, Record<string, unknown>>;
      if (wallpaper) {
        const image = await uploadImage(client, wallpaper, 'wallpaper');
        body.wallpaper = { ...body.wallpaper, background_image_attachment_id: image };
      }
      if (header) {
        const image = await uploadImage(client, header, 'header');
        body.header = { ...body.header, header_image_attachment_id: image };
      }
      return client.request({ method: 'PATCH', path, body });
    },
    examples: [
      'jinshuju form theme set Kp7mQ2 --primary-color "#1F6FEB"',
      'jinshuju form theme set Kp7mQ2 --wallpaper ./bg.png'
    ]
  },
  {
    path: ['form', 'rule', 'get'],
    summary: 'Show the field display rules of a form',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    request: (input) => ({ method: 'GET', path: `${API}/forms/${input.args.form}/field_rules` })
  },
  {
    path: ['form', 'rule', 'edit'],
    summary: 'Edit the field display rules of a form',
    description: 'The payload is {add, update, remove}; a rule is targeted by the index `form rule get` shows.',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    options: [JSON_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: `${API}/forms/${input.args.form}`,
      body: { field_rules: payload(input) }
    })
  },
  {
    path: ['form', 'cooperator', 'list'],
    summary: 'List the cooperators of a form',
    args: [{ name: 'form', required: true, description: 'Form token' }],
    request: (input) => ({ method: 'GET', path: `${API}/forms/${input.args.form}/cooperators` })
  }
];
