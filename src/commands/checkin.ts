import { JSON_OPTION, LIMIT_OPTION, UsageError } from '../options.js';
import { call } from '../spec.js';
import { YES_OPTION, confirmed, overriding, paging, requiredOption } from './shared.js';
import type { Command, CommandInput } from './types.js';

const CAMPAIGN_ARG = { name: 'campaign', required: true, description: 'Check-in campaign id' };

const NAME_OPTION = { name: '--name', type: 'string', placeholder: '<name>', description: 'Campaign name' } as const;

const DISPLAY_FIELD_OPTION = {
  name: '--display-field',
  type: 'string',
  placeholder: '<api-code>',
  description: 'Field shown to staff when they verify a check-in, usually the name'
} as const;

const TIMES_EXAMPLE =
  'jinshuju checkin edit 42 --json \'{"date_settings":[{"start_date":"2026-10-20","end_date":"2026-10-21",' +
  '"periods":["Tuesday"],"durations":[{"start":"09:00","end":"12:00"}]}]}\'';

function rest(input: CommandInput): Record<string, unknown> {
  return (input.options.json as Record<string, unknown> | undefined) ?? {};
}

export const CHECKIN: readonly Command[] = [
  {
    path: ['checkin', 'list'],
    summary: 'List your check-in campaigns',
    options: [
      { name: '--form', type: 'string', placeholder: '<token>', description: 'Only the campaigns of this form' },
      { ...LIMIT_OPTION, description: 'Campaigns to return (default 50, up to 100)' }
    ],
    request: (input) =>
      call('listCheckinCampaigns', {
        query: { limit: paging(input).limit, form_token: input.options.form as string | undefined }
      })
  },
  {
    path: ['checkin', 'get'],
    summary: 'Show a check-in campaign and its links',
    args: [CAMPAIGN_ARG],
    request: (input) => call('getCheckinCampaign', { path: { id: input.args.campaign } })
  },
  {
    path: ['checkin', 'create'],
    summary: 'Turn on check-in for a form',
    description:
      'Registrants check in with the field given by --check-in-field, the first mobile field when left out. ' +
      'It cannot be changed afterwards. With a check-in code (the default) the form shows the code after ' +
      'submitting, which takes over its after-submit redirect; --no-check-in-code leaves that alone. ' +
      'Times and a location limit go through --json.',
    options: [
      { name: '--form', type: 'string', placeholder: '<token>', description: 'Form to check in against' },
      NAME_OPTION,
      {
        name: '--check-in-field',
        type: 'string',
        placeholder: '<api-code>',
        description: 'Field registrants check in with (default: first mobile field, then first name field)'
      },
      DISPLAY_FIELD_OPTION,
      { name: '--no-check-in-code', type: 'boolean', description: 'Do not show a check-in code after submitting' },
      {
        name: '--unique-check-in-field',
        type: 'boolean',
        description: 'Also make the check-in field required and unique, so every registrant can be found'
      },
      JSON_OPTION
    ],
    request: (input) =>
      call('createCheckinCampaign', {
        body: overriding(rest(input), {
          form_token: requiredOption(input, 'form'),
          name: input.options.name,
          checkin_field_api_code: input.options.check_in_field,
          display_field_api_code: input.options.display_field,
          enable_checkin_code: input.options.no_check_in_code ? false : undefined,
          checkin_field_required_unique: input.options.unique_check_in_field || undefined
        })
      }),
    examples: [
      'jinshuju checkin create --form Kp7mQ2',
      'jinshuju checkin create --form Kp7mQ2 --name 年会签到 --json \'{"geo_location":{"longitude":108.9,"latitude":34.2,"range":500}}\''
    ]
  },
  {
    path: ['checkin', 'edit'],
    summary: 'Edit a check-in campaign, or pause and resume it',
    description:
      'Only what is named changes. date_settings in --json replaces the times as a whole; an empty list lifts the limit.',
    args: [CAMPAIGN_ARG],
    options: [
      NAME_OPTION,
      DISPLAY_FIELD_OPTION,
      { name: '--enable', type: 'boolean', description: 'Resume check-in' },
      { name: '--disable', type: 'boolean', description: 'Pause check-in; records are kept' },
      JSON_OPTION
    ],
    request: (input) => {
      if (input.options.enable && input.options.disable) {
        throw new UsageError('--enable and --disable are opposites, pass one');
      }
      return call('updateCheckinCampaign', {
        path: { id: input.args.campaign },
        body: overriding(rest(input), {
          name: input.options.name,
          display_field_api_code: input.options.display_field,
          enabled: input.options.enable ? true : input.options.disable ? false : undefined
        })
      });
    },
    examples: [
      'jinshuju checkin edit 42 --disable',
      TIMES_EXAMPLE,
      'jinshuju checkin edit 42 --json \'{"geo_location":null}\''
    ]
  },
  {
    path: ['checkin', 'delete'],
    summary: 'Delete a check-in campaign',
    description: 'Its check-in records go with it. To stop check-in for now, use `checkin edit --disable`.',
    args: [CAMPAIGN_ARG],
    options: [YES_OPTION],
    request: (input) => {
      confirmed(input, `Deleting check-in campaign ${input.args.campaign}`);
      return call('deleteCheckinCampaign', { path: { id: input.args.campaign } });
    },
    select: (body, input) => body ?? { id: Number(input.args.campaign) }
  }
];
