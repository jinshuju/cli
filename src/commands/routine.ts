import { JSON_OPTION, PAGINATION_OPTIONS, UsageError, type OptionSpec } from '../options.js';
import { isRecord } from '../values.js';
import { API, LISTING, YES_OPTION, confirmed, overriding, paging } from './shared.js';
import type { Command, CommandInput } from './types.js';

/**
 * Routines (自动任务): an instruction Jiri carries out on a schedule, or when the
 * data of a form or table changes. The rules — how long a name may be, which
 * fields may trigger, how many routines may be active — are the 自动任务 page's,
 * and the server answers in that page's words. The CLI checks shapes only.
 */

const ROUTINES = `${API}/routines`;

/**
 * The whole of what create and update read, shown rather than described. The
 * schedule is the part an agent gets wrong by guessing — which key each freq
 * takes, which day is 1 — so every freq is spelled out.
 */
const ROUTINE_PAYLOAD: readonly string[] = [
  '{',
  '  "name": "每周报名汇总",',
  '  "instruction": "汇总上周（周一到周日）报名表新增的数据，按渠道统计条数",',
  '  "objects": [{ "kind": "form", "token": "Kp7mQ2" }],',
  '  "trigger_kind": "schedule",',
  '  "schedule": { "freq": "weekly", "weekdays": [1], "time": "09:00" }',
  '}',
  '',
  'name is up to 60 characters, instruction up to 2000. objects are the forms,',
  'tables, views and public queries the routine may work on: 1 to 10 of',
  '{ "kind": form | table | view | opensearch, "token" }. trigger_kind is schedule',
  'or event; create defaults to schedule, update keeps what the routine has.',
  '',
  'schedule is Beijing time (Asia/Shanghai). Send the keys its freq uses:',
  '  once      "at": "2026-10-12T09:00", or ISO 8601 with +08:00; in the future',
  '  hourly    "minute": 0-59',
  '  daily     "time": "HH:MM"',
  '  workdays  "time": "HH:MM"; Monday to Friday, public holidays not skipped',
  '  weekly    "weekdays": [1-7], "time": "HH:MM"; 1 is Monday, 7 is Sunday',
  '  monthly   "month_days": [1-31, or -1 for the last day], "time": "HH:MM";',
  '            a month without the day is skipped, not moved',
  '',
  'event, with "trigger_kind": "event" in place of a schedule:',
  '  { "source_kind": "form" | "table", "source_token": "Kp7mQ2",',
  '    "on": "created" | "updated" | "matched",',
  '    "field_codes": ["field_3"],',
  '    "scope_conditions": [{ "trigger": "field_5", "operator": "eq",',
  '                           "value": "code_vip", "group_index": 0 }],',
  '    "include_bulk": false }',
  '  on created   runs for each new entry',
  '  on updated   runs when one of field_codes changes: 1 to 10 api_codes;',
  '               formula and linked (关联) fields cannot be watched',
  '  on matched   runs when an entry comes to meet scope_conditions (required)',
  '  scope_conditions narrow created and updated too; updated reads the values',
  '  after the change. The source joins objects by itself.',
  '  include_bulk: imports and batch edits trigger as well, as one run.',
  '',
  'A condition is the one a view filters by:',
  '  trigger      the api_code; a subtable column is field_3.field_1',
  '  operator     eq ne gt gte lt lte any_in none_in between not_between like',
  '               not_like null not_null',
  '  value        a choice is its value code (see `jinshuju field list`), never',
  '               its label; a list for any_in and none_in, two for between,',
  '               none for null and not_null. A date also takes today,',
  '               yesterday, this_week, last_week, this_month, last_month,',
  '               last_7, last_30',
  '  group_index  conditions sharing an index must all hold; a negative index',
  '               makes its group any-of; separate groups are alternatives',
  '  scope_attr   only for a ReservationField: date_time or api_code',
  '',
  'delete_authorized cannot be set here, true or false: the server refuses the',
  'key. Letting a routine delete data is turned on on the 自动任务 page only.'
];

/** What --schedule reads after the freq, for its help and its errors alike. */
const SCHEDULE_FORMS: Record<string, string> = {
  once: '<YYYY-MM-DD> <HH:MM>',
  hourly: '<minute>',
  daily: '<HH:MM>',
  workdays: '<HH:MM>',
  weekly: '<weekdays> <HH:MM>',
  monthly: '<days> <HH:MM>'
};

const SCHEDULE_GRAMMAR = Object.entries(SCHEDULE_FORMS)
  .map(([freq, rest]) => `'${freq} ${rest}'`)
  .join(', ');

/** A comma-separated list of days, -1 among them for a month's last. */
function days(raw: string, flag: string): number[] {
  return raw.split(',').map((day) => {
    if (!/^-?\d+$/.test(day.trim())) {
      throw new UsageError(`${flag} days must be whole numbers separated by commas, got ${JSON.stringify(raw)}`);
    }
    return Number.parseInt(day, 10);
  });
}

/**
 * `weekly 1,5 09:00` into the schedule object the API reads, so one command
 * can create any of the six. Only the words are checked: whether 8 is a
 * weekday or the time has passed is the server's to say, in the page's words.
 */
export function parseSchedule(input: string): Record<string, unknown> {
  const [freq = '', ...rest] = input.trim().split(/\s+/);
  const form = SCHEDULE_FORMS[freq];
  if (form === undefined) {
    throw new UsageError(
      `--schedule must be one of ${SCHEDULE_GRAMMAR}, got ${JSON.stringify(input)}. ` +
        'Anything else goes in the payload: see --help'
    );
  }
  const wanted = form.split(' ').length;
  // The date and the time of a once may come as one ISO word or as two.
  const fits = rest.length === wanted || (freq === 'once' && rest.length === 1);
  if (!fits) throw new UsageError(`--schedule '${freq}' must be '${freq} ${form}', got ${JSON.stringify(input)}`);

  const [first, second] = rest as [string, string | undefined];
  switch (freq) {
    case 'once':
      return { freq, at: second === undefined ? first : `${first}T${second}` };
    case 'hourly':
      if (!/^\d+$/.test(first))
        throw new UsageError(`--schedule hourly takes the minute, got ${JSON.stringify(first)}`);
      return { freq, minute: Number.parseInt(first, 10) };
    case 'weekly':
      return { freq, weekdays: days(first, '--schedule weekly'), time: second };
    case 'monthly':
      return { freq, month_days: days(first, '--schedule monthly'), time: second };
    default:
      return { freq, time: first };
  }
}

/** `form:Kp7mQ2` into `{ kind, token }`. The kinds are the server's to check. */
export function parseObject(input: string): { kind: string; token: string } {
  const separator = input.indexOf(':');
  const kind = input.slice(0, separator);
  const token = input.slice(separator + 1);
  if (separator === -1 || !kind || !token) {
    throw new UsageError(`--object must be '<kind>:<token>', e.g. form:Kp7mQ2, got ${JSON.stringify(input)}`);
  }
  return { kind, token };
}

/** What create and update both take; update names the routine as well. */
const ROUTINE_OPTIONS: readonly OptionSpec[] = [
  { name: '--name', type: 'string', placeholder: '<name>', description: 'Name, up to 60 characters' },
  {
    name: '--instruction',
    type: 'string',
    placeholder: '<text>',
    description: 'What Jiri does on each run, up to 2000 characters'
  },
  {
    name: '--object',
    type: 'string',
    repeatable: true,
    placeholder: '<kind>:<token>',
    description:
      'What the routine works on, repeatable, up to 10; kind is form, table, view or opensearch. ' +
      'Given, it is the whole list'
  },
  {
    name: '--schedule',
    type: 'string',
    placeholder: "'<freq> ...'",
    description:
      `Run on a schedule, Beijing time: ${SCHEDULE_GRAMMAR}. ` +
      'Weekdays run 1 (Monday) to 7; days 1 to 31, -1 for the last. Sets trigger_kind to schedule'
  },
  JSON_OPTION
];

/**
 * The payload with the flags that were given laid over it. A flag wins over the
 * same key in the payload, and a flag left out leaves the payload's alone.
 */
function routineBody(input: CommandInput): Record<string, unknown> {
  const raw = input.options.json;
  if (raw !== undefined && !isRecord(raw)) throw new UsageError('--json must be a JSON object');
  const objects = (input.options.object as string[] | undefined)?.map(parseObject);
  const spec = input.options.schedule as string | undefined;
  const schedule = spec === undefined ? undefined : parseSchedule(spec);
  return overriding((raw as Record<string, unknown> | undefined) ?? {}, {
    name: input.options.name,
    instruction: input.options.instruction,
    objects,
    trigger_kind: schedule ? 'schedule' : undefined,
    schedule
  });
}

/**
 * A row of a listing as a person scans it: which routine, whether it is on,
 * when it runs and when it runs next. The instruction, the objects and the raw
 * schedule are `routine get`'s, and `--output json` keeps all of it.
 */
function routinesForReading(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.data)) return body;
  return {
    ...body,
    data: body.data.map((row: unknown) => {
      if (!isRecord(row)) return row;
      const next = Array.isArray(row.next_runs) ? row.next_runs[0] : undefined;
      return { id: row.id, name: row.name, state: row.state, trigger: row.trigger_text, next_run: next };
    })
  };
}

const ROUTINE_ARG = { name: 'routine', required: true, description: 'Routine id, from `jinshuju routine list`' };

export const ROUTINE: readonly Command[] = [
  {
    path: ['routine', 'list'],
    summary: 'List your routines: state, when each runs, and its next run',
    options: [
      {
        name: '--state',
        type: 'string',
        choices: ['active', 'paused'],
        placeholder: '<state>',
        description: 'Only the active or the paused ones'
      },
      ...PAGINATION_OPTIONS
    ],
    request: (input) => ({
      method: 'GET',
      path: ROUTINES,
      query: { state: input.options.state as string | undefined, ...paging(input) }
    }),
    paginate: LISTING,
    render: routinesForReading,
    examples: ['jinshuju routine list', 'jinshuju routine list --state paused --all']
  },
  {
    path: ['routine', 'get'],
    summary: 'Show a routine: its instruction, trigger, next runs, objects and page link',
    description:
      "trigger_text says when it runs in the 自动任务 page's words; next_runs holds the next five times of an " +
      'active schedule, and is empty otherwise. url opens the routine on the page.',
    args: [ROUTINE_ARG],
    request: (input) => ({ method: 'GET', path: `${ROUTINES}/${input.args.routine}` }),
    examples: ['jinshuju routine get 6ac5f0e2b1d4c3a2f1e0d9c8']
  },
  {
    path: ['routine', 'create'],
    summary: 'Create a routine; it is active at once',
    description:
      'The flags cover a scheduled routine in one command; an event trigger and its conditions go in --json, ' +
      'and the flags still apply on top of it. The answer is the routine as `routine get` shows it, url included.',
    options: ROUTINE_OPTIONS,
    payload: ROUTINE_PAYLOAD,
    request: (input) => ({ method: 'POST', path: ROUTINES, body: routineBody(input) }),
    examples: [
      "jinshuju routine create --name 每周报名汇总 --instruction '汇总上周（周一到周日）报名表新增的数据，按渠道统计条数' " +
        "--object form:Kp7mQ2 --schedule 'weekly 1 09:00'",
      "jinshuju routine create --name 活动提醒 --instruction '…' --object table:Vn4xR8 --schedule 'once 2026-10-12 09:00'",
      "jinshuju routine create --name 巡检 --instruction '…' --object form:Kp7mQ2 --schedule 'hourly 30'",
      "jinshuju routine create --name 月报 --instruction '…' --object form:Kp7mQ2 --schedule 'monthly 1,-1 18:00'",
      'jinshuju routine create --name 新报名通知 --instruction \'…\' --json \'{"trigger_kind":"event",' +
        '"event":{"source_kind":"form","source_token":"Kp7mQ2","on":"created"}}\'',
      'jinshuju routine create --json @routine.json'
    ]
  },
  {
    path: ['routine', 'update'],
    summary: 'Change a routine: name, instruction, objects or trigger',
    description:
      'Only what is named changes. --object replaces the whole list. Moving to a schedule is --schedule; ' +
      'moving to an event is --json with "trigger_kind": "event" and the event. The payload is the one ' +
      '`routine create --help` shows.',
    args: [ROUTINE_ARG],
    options: ROUTINE_OPTIONS,
    request: (input) => ({ method: 'PATCH', path: `${ROUTINES}/${input.args.routine}`, body: routineBody(input) }),
    examples: [
      "jinshuju routine update 6ac5f0e2b1d4c3a2f1e0d9c8 --schedule 'workdays 08:30'",
      "jinshuju routine update 6ac5f0e2b1d4c3a2f1e0d9c8 --instruction '…' --object form:Kp7mQ2 --object table:Vn4xR8"
    ]
  },
  {
    path: ['routine', 'pause'],
    summary: 'Pause a routine; it stops running until resumed',
    args: [ROUTINE_ARG],
    request: (input) => ({ method: 'POST', path: `${ROUTINES}/${input.args.routine}/pause` })
  },
  {
    path: ['routine', 'resume'],
    summary: 'Resume a paused routine',
    description: 'Refused while 20 routines are already active, as on the page.',
    args: [ROUTINE_ARG],
    request: (input) => ({ method: 'POST', path: `${ROUTINES}/${input.args.routine}/resume` })
  },
  {
    path: ['routine', 'run'],
    summary: 'Run a routine once, now',
    description:
      'Starts a run and answers with it rather than waiting for it to finish: read how it went with ' +
      '`routine runs`. A run spends AI points, the same as a scheduled one.',
    args: [ROUTINE_ARG],
    request: (input) => ({ method: 'POST', path: `${ROUTINES}/${input.args.routine}/run` })
  },
  {
    path: ['routine', 'delete'],
    summary: 'Delete a routine for good',
    description: 'Runs still under way are cancelled. Finished runs and their conversations stay.',
    args: [ROUTINE_ARG],
    options: [YES_OPTION],
    request: (input) => {
      confirmed(input, `Deleting routine ${input.args.routine}`);
      return { method: 'DELETE', path: `${ROUTINES}/${input.args.routine}` };
    }
  },
  {
    path: ['routine', 'runs'],
    summary: "List a routine's runs, newest first",
    description: 'Each run says how it went: state, error, and the title and summary the run reported.',
    args: [ROUTINE_ARG],
    options: [...PAGINATION_OPTIONS],
    request: (input) => ({ method: 'GET', path: `${ROUTINES}/${input.args.routine}/runs`, query: paging(input) }),
    paginate: LISTING,
    examples: ['jinshuju routine runs 6ac5f0e2b1d4c3a2f1e0d9c8 --limit 5']
  }
];
