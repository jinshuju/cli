import { JSON_OPTION, PAGINATION_OPTIONS, UsageError, type OptionSpec } from '../options.js';
import { call, choices } from '../spec.js';
import { isRecord } from '../values.js';
import { LISTING, YES_OPTION, confirmed, overriding, paging } from './shared.js';
import type { Command, CommandInput } from './types.js';

/**
 * Routines (自动任务): an instruction Jiri carries out on a schedule, or when the
 * data of a form or table changes. The rules — how long a name may be, which
 * fields may trigger, how many routines may be active — are the 自动任务 page's,
 * and the server answers in that page's words. The CLI checks shapes only.
 */

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
  'tables, views and public queries the routine may work on: up to 10 of',
  '{ "kind": form | table | view | opensearch, "token" }. trigger_kind is schedule',
  'or event; create defaults to schedule. On update a key left out, or null,',
  'keeps what the routine has, and objects given replace them all.',
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
  '  value        shaped as the field takes it in an entry, which',
  '               `jinshuju field types <Type>` shows under value: a choice is',
  '               its value code (see `jinshuju field list`), never its label;',
  '               a list for any_in and none_in, two for between,',
  '               none for null and not_null. A date also takes today,',
  '               yesterday, tomorrow, this_week, last_week, this_month,',
  '               last_month, next_month, last_1, last_3, last_7, last_30',
  '  group_index  conditions sharing an index must all hold; a negative index',
  '               makes its group any-of; separate groups are alternatives',
  '  scope_attr   only for a ReservationField: date_time or api_code',
  '',
  'Keys the API does not read are ignored, so `routine get --output json` can be',
  'edited and sent back, once delete_authorized is taken out of it.',
  '',
  'delete_authorized cannot be sent, true or false: letting a routine delete',
  'data is turned on on the 自动任务 page only.'
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
 *
 * delete_authorized is the one key refused here rather than by the server. The
 * server refuses it too, true or false, so sending it can only fail; and the
 * one way it gets into a payload unasked is a routine read back from `routine
 * get`, which carries it, where the caller is better told before the request.
 */
function routineBody(input: CommandInput): Record<string, unknown> {
  const raw = input.options.json;
  if (raw !== undefined && !isRecord(raw)) throw new UsageError('--json must be a JSON object');
  if (raw !== undefined && 'delete_authorized' in raw) {
    throw new UsageError(
      'delete_authorized cannot be sent: letting a routine delete data is turned on on the 自动任务 page only. ' +
        'Take it out of --json'
    );
  }
  const objects = (input.options.object as string[] | undefined)?.map(parseObject);
  const spec = input.options.schedule as string | undefined;
  const schedule = spec === undefined ? undefined : parseSchedule(spec);
  return overriding(raw ?? {}, {
    name: input.options.name,
    instruction: input.options.instruction,
    objects,
    trigger_kind: schedule ? 'schedule' : undefined,
    schedule
  });
}

/** A listing's rows cut down to the given keys, each named as the row has it. */
function rowsForReading(body: unknown, row: (item: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (!isRecord(body) || !Array.isArray(body.data)) return body;
  return { ...body, data: body.data.map((item: unknown) => (isRecord(item) ? row(item) : item)) };
}

/**
 * A row of a listing as a person scans it: which routine, whether it is on and
 * why not, when it runs and when it runs next. The instruction, the objects and
 * the raw schedule are `routine get`'s, and `--output json` keeps all of it.
 */
function routinesForReading(body: unknown): unknown {
  return rowsForReading(body, (row) => ({
    id: row.id,
    name: row.name,
    state: row.state,
    paused_reason: row.paused_reason,
    trigger_text: row.trigger_text,
    next_run_at: row.next_run_at
  }));
}

/** A run as a person scans it: how it went and what it was called. The summary and links are in json. */
function runsForReading(body: unknown): unknown {
  return rowsForReading(body, (row) => ({
    id: row.id,
    state: row.state,
    trigger_kind: row.trigger_kind,
    scheduled_at: row.scheduled_at,
    error: row.error,
    title: row.title
  }));
}

const ROUTINE_ARG = { name: 'routine', required: true, description: 'Routine id, from `jinshuju routine list`' };

export const ROUTINE: readonly Command[] = [
  {
    path: ['routine', 'list'],
    summary: 'List your routines: state, when each runs, and its next run',
    description: 'Your own routines, newest first.',
    options: [
      {
        name: '--state',
        type: 'string',
        choices: choices('listRoutines', 'state'),
        placeholder: '<state>',
        description: 'Only the active or the paused ones'
      },
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listRoutines', { query: { state: input.options.state as string | undefined, ...paging(input) } }),
    paginate: LISTING,
    render: routinesForReading,
    examples: ['jinshuju routine list', 'jinshuju routine list --state paused --all']
  },
  {
    path: ['routine', 'get'],
    summary: 'Show a routine: its instruction, trigger, next runs, objects and page link',
    description:
      "trigger_text says when it runs in the 自动任务 page's words; next_runs holds the next five times of an " +
      'active schedule, and is empty otherwise. A data trigger has its conditions in words under ' +
      'event.conditions, and as stored under event.scope_conditions, which is what update takes back. ' +
      'last_run is the latest run, and url opens the routine on the page.',
    args: [ROUTINE_ARG],
    request: (input) => call('getRoutine', { path: { id: input.args.routine } }),
    examples: ['jinshuju routine get 6ac5f0e2b1d4c3a2f1e0d9c8']
  },
  {
    path: ['routine', 'create'],
    summary: 'Create a routine; it is active at once',
    description:
      'The flags cover a scheduled routine in one command; an event trigger and its conditions go in --json, ' +
      'and the flags still apply on top of it. The answer is the routine as `routine get` shows it, url included. ' +
      "A routine against the page's rules is refused with every reason the page gives.",
    options: ROUTINE_OPTIONS,
    payload: ROUTINE_PAYLOAD,
    request: (input) => call('createRoutine', { body: routineBody(input) }),
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
      '`routine create --help` shows. A changed schedule cancels the runs queued for the old one; a changed ' +
      'instruction or objects stops a run in progress.',
    args: [ROUTINE_ARG],
    options: ROUTINE_OPTIONS,
    request: (input) => call('updateRoutine', { path: { id: input.args.routine }, body: routineBody(input) }),
    examples: [
      "jinshuju routine update 6ac5f0e2b1d4c3a2f1e0d9c8 --schedule 'workdays 08:30'",
      "jinshuju routine update 6ac5f0e2b1d4c3a2f1e0d9c8 --instruction '…' --object form:Kp7mQ2 --object table:Vn4xR8"
    ]
  },
  {
    path: ['routine', 'pause'],
    summary: 'Pause a routine; it stops running until resumed',
    description: 'Its queued and running runs are cancelled. Pausing a paused routine answers it as it is.',
    args: [ROUTINE_ARG],
    request: (input) => call('pauseRoutine', { path: { routine_id: input.args.routine } })
  },
  {
    path: ['routine', 'resume'],
    summary: 'Resume a paused routine',
    description:
      'It runs again from its next time after now; times missed while paused are not made up. Refused, as on ' +
      'the page, while 20 routines are already active, or for a one-off whose time has passed.',
    args: [ROUTINE_ARG],
    request: (input) => call('resumeRoutine', { path: { routine_id: input.args.routine } })
  },
  {
    path: ['routine', 'run'],
    summary: 'Run a routine once, now',
    description:
      'Queues a run, paused routines included, and answers with it rather than waiting for it to finish: ' +
      'read how it went with `routine runs`. A run spends AI points, the same as a scheduled one. Refused ' +
      'while a run is still in progress.',
    args: [ROUTINE_ARG],
    request: (input) => call('runRoutine', { path: { routine_id: input.args.routine } })
  },
  {
    path: ['routine', 'delete'],
    summary: 'Delete a routine for good',
    description: 'Its queued and running runs are cancelled. The conversations of its past runs stay.',
    args: [ROUTINE_ARG],
    options: [YES_OPTION],
    request: (input) => {
      confirmed(input, `Deleting routine ${input.args.routine}`);
      return call('deleteRoutine', { path: { id: input.args.routine } });
    }
  },
  {
    path: ['routine', 'runs'],
    summary: "List a routine's runs, latest first",
    description:
      'Each run says how it went: state, error, and the title the run reported. Its summary and the link ' +
      'to its conversation are in --output json.',
    args: [ROUTINE_ARG],
    options: [...PAGINATION_OPTIONS],
    request: (input) => call('listRoutineRuns', { path: { routine_id: input.args.routine }, query: paging(input) }),
    paginate: LISTING,
    render: runsForReading,
    examples: ['jinshuju routine runs 6ac5f0e2b1d4c3a2f1e0d9c8 --limit 5']
  }
];
