import { CONTAINER_OPTIONS, JSON_OPTION, UsageError, type OptionSpec } from '../options.js';
import type { HttpClient } from '../http.js';
import { call, choices } from '../spec.js';
import { isRecord } from '../values.js';
import { YES_OPTION, confirmed, onContainer, one, payload, requiredOption } from './shared.js';
import type { Command, CommandInput } from './types.js';

/**
 * One field, or a list of them — the same objects `fields` holds above. A
 * field reads in the shape a write takes, so what `field list` answers goes
 * back as it came; what is left to say is which of the keys it carries a
 * write cannot change.
 */
const FIELD_PAYLOAD: readonly string[] = [
  '{ "type": "TextField", "label": "Notes", "required": false }',
  '',
  'A field as `form get` or `field list` returns it can be written back as it is, whole or',
  'a few of its keys:',
  '  null for a setting clears it, or puts it back to its default',
  '  choices on `field update` are the whole list the field should have, in its order: each',
  '    is matched by api_code or text, a new one is added, one left out is removed (--yes if',
  '    it holds answers). `field update-choices` makes single changes',
  "  a key no write can change, like api_code_alias or a choice's hidden, goes back only as",
  '    it was read; the API answers which key when one differs',
  '',
  'Field types: jinshuju field types'
];

/** A form's or table's fields, each with its api_code, as the API answers them. */
function selectFields(body: unknown): Record<string, unknown>[] {
  return (body as { fields?: Record<string, unknown>[] } | undefined)?.fields ?? [];
}

/** `field_7:choice_1` into the target the check endpoint reads. */
function parseCheckTarget(target: string): Record<string, unknown> {
  const [field_api_code, choice_value] = target.split(':');
  if (!field_api_code)
    throw new UsageError(`a check target must be '<api-code>[:<choice>]', got ${JSON.stringify(target)}`);
  return choice_value === undefined ? { field_api_code } : { field_api_code, choice_value };
}

/**
 * The targets a batch check asks about: the plain ones as arguments, and the
 * shapes the argument grammar cannot reach through --json. Both at once is
 * allowed — one edit's targets belong in one call, whatever shape each is.
 */
function checks(input: CommandInput, parse: (target: string) => Record<string, unknown>): unknown[] {
  const fromArgs = input.rest.map(parse);
  const fromJson = input.options.json === undefined ? [] : one(input.options.json);
  const all = [...fromArgs, ...fromJson];
  if (all.length === 0) throw new UsageError('name at least one target, as an argument or through --json');
  return all;
}

/**
 * Whether each target may hold answers, asked of the same check `field check`
 * makes. Only a plain "no data" counts as none: a target the check could not
 * read, or a check that failed, is taken to hold some, so the caller is asked
 * rather than an answer lost. The reason a check failed rides along.
 */
async function holdingData(
  client: HttpClient,
  input: CommandInput,
  targets: readonly Record<string, unknown>[]
): Promise<{ holding: boolean[]; unsure?: string }> {
  try {
    const body = await client.request(
      onContainer(input, 'checkFormFieldData', 'checkTableFieldData', {
        query: { checks: JSON.stringify(targets) }
      })
    );
    const results = isRecord(body) && Array.isArray(body.results) ? body.results : [];
    return { holding: targets.map((_, index) => !(isRecord(results[index]) && results[index].has_data === false)) };
  } catch (error) {
    return { holding: targets.map(() => true), unsure: (error as Error).message };
  }
}

/**
 * Removing what holds no answers loses nothing, so it goes ahead unasked; only
 * what does, or might, waits for --yes. Asking for a confirmation that guards
 * nothing taught callers to add --yes to every remove, which is the habit that
 * would let the one that matters through.
 */
async function confirmedIfHolding(
  client: HttpClient,
  input: CommandInput,
  targets: readonly Record<string, unknown>[],
  what: string
): Promise<void> {
  if (input.options.yes || targets.length === 0) return;
  const { holding, unsure } = await holdingData(client, input, targets);
  if (!holding.some(Boolean)) return;
  const reason = unsure === undefined ? 'holds answers' : `may hold answers (the check failed: ${unsure})`;
  confirmed(input, `${what} ${reason}, and removing it deletes them`, 'for good');
}

/** The operations as given, with a choice to update named by `name` read as its `value`. */
function choiceChanges(given: unknown): Record<string, unknown> {
  const changes = given as Record<string, unknown>;
  return Array.isArray(changes.update) ? { ...changes, update: changes.update.map(withValue) } : changes;
}

/** A choice as a caller writes it: its text, from `value`, `name`, or the bare string. */
function choiceText(choice: unknown): string | undefined {
  if (typeof choice === 'string') return choice;
  if (!isRecord(choice)) return undefined;
  const text = choice.value ?? choice.name;
  return typeof text === 'string' ? text : undefined;
}

/** What `update_choices` calls `value`, written as `name`, which `add` takes and `update` does not. */
function withValue(item: unknown): unknown {
  if (!isRecord(item) || item.name === undefined || item.value !== undefined) return item;
  const { name, ...rest } = item;
  return { ...rest, value: name };
}

/**
 * A whole list of choices on `field update`, the shape `field add` takes, turned
 * into the operations the API takes instead: one that names its choices in full
 * is refused there, and "these are the choices now" has only one meaning. Each
 * is matched to a choice the field has by api_code, else by its text; one with
 * no match is added, and a choice the list leaves out is removed.
 *
 * The list's order is the order asked for. When removing and appending leave
 * the choices in it already, no position is sent; otherwise every choice that
 * stays and every one added gets one (`placed`).
 */
function choiceOperations(
  current: readonly Record<string, unknown>[],
  given: readonly unknown[]
): { add: unknown[]; update: Record<string, unknown>[]; remove: Record<string, unknown>[] } {
  // Each slot of the list asked for: a choice the field has, by its index, or one to add.
  const slots: ({ kept: number } | { added: unknown })[] = [];
  const changes = new Map<number, Record<string, unknown>>();
  for (const item of given) {
    const code = isRecord(item) ? item.api_code : undefined;
    const text = choiceText(item);
    const index = current.findIndex((choice) =>
      code !== undefined ? choice.api_code === code : choice.value === text
    );
    if (index === -1 || slots.some((slot) => 'kept' in slot && slot.kept === index)) {
      slots.push({ added: typeof item === 'string' ? { value: item } : item });
      continue;
    }
    slots.push({ kept: index });
    const choice = current[index] as Record<string, unknown>;
    if (!isRecord(item)) continue;
    const changed = Object.entries(withValue(item) as Record<string, unknown>).filter(
      ([key, value]) => key !== 'api_code' && JSON.stringify(choice[key]) !== JSON.stringify(value)
    );
    if (changed.length > 0) changes.set(index, Object.fromEntries(changed));
  }
  const kept = slots.flatMap((slot) => ('kept' in slot ? [slot.kept] : []));
  const remove = current.filter((_, index) => !kept.includes(index));
  const positions = placed(
    slots,
    [...kept].sort((a, b) => a - b)
  );
  const add = slots.flatMap((slot, at) => ('added' in slot ? [{ at, item: slot.added }] : []));
  const update = slots.flatMap((slot, at) => {
    if (!('kept' in slot)) return [];
    const change = { ...changes.get(slot.kept), ...(positions ? { position: at } : {}) };
    return Object.keys(change).length > 0 ? [{ api_code: current[slot.kept]?.api_code, ...change }] : [];
  });
  return {
    add: (positions
      ? [...add].sort((a, b) => (positions.get(a.at) as number) - (positions.get(b.at) as number))
      : add
    ).map(({ at, item }) => (positions ? { ...(item as Record<string, unknown>), position: positions.get(at) } : item)),
    update,
    remove
  };
}

/**
 * Where each choice to add has to be inserted for the list to come out in the
 * order asked, or undefined when appending already does. Keyed by slot.
 *
 * The API removes first, then inserts each addition at its position in turn,
 * then moves each choice given a position, lowest position first: out of
 * where it is, into that place. Every choice that stays is moved to its own
 * slot, so the moves are fixed; what is left to choose is where the additions
 * go in. That is found by playing the moves backwards from the list asked
 * for: each choice moved is taken out of its slot and put back among the ones
 * already put back in the order the field has them now. What is left is the
 * list just before the moves, and the additions' places in it are where they
 * are inserted, lowest first.
 */
function placed(
  slots: readonly ({ kept: number } | { added: unknown })[],
  keptNow: readonly number[]
): Map<number, number> | undefined {
  const appended = [
    ...keptNow.map((index) => slots.findIndex((slot) => 'kept' in slot && slot.kept === index)),
    ...slots.flatMap((slot, at) => ('added' in slot ? [at] : []))
  ];
  if (appended.every((at, index) => at === index)) return undefined;

  const list = slots.map((_, at) => at);
  const back: number[] = [];
  const rank = (at: number) => keptNow.indexOf((slots[at] as { kept: number }).kept);
  for (let at = slots.length - 1; at >= 0; at -= 1) {
    if (!('kept' in (slots[at] as object))) continue;
    list.splice(list.indexOf(at), 1);
    const after = back.filter((other) => rank(other) > rank(at)).map((other) => list.indexOf(other));
    const before = back.filter((other) => rank(other) < rank(at)).map((other) => list.indexOf(other));
    const where = after.length > 0 ? Math.min(...after) : before.length > 0 ? Math.max(...before) + 1 : list.length;
    list.splice(where, 0, at);
    back.push(at);
  }
  return new Map(slots.flatMap((slot, at) => ('added' in slot ? [[at, list.indexOf(at)] as const] : [])));
}

export const FIELD_SCOPES = ['normal', 'exam', 'customized'] as const;

/**
 * A listing has to stay scannable and one type has to be readable, and those
 * want opposite things from `structure`: its descriptions are sentences, which
 * turn a table of fifty rows into a wall. A listing shows which keys a type
 * takes; naming one type spells them out.
 */
function fieldTypesForReading(body: unknown): unknown {
  const rows = (body as { data?: Record<string, unknown>[] }).data ?? [];
  if (rows.length !== 1) {
    return {
      data: rows.map((row) => ({
        ...row,
        structure: Object.keys((row.structure as Record<string, unknown>) ?? {}).join(', ') || undefined
      }))
    };
  }
  return rows[0];
}

/**
 * Fields as a listing, cut out of the form that answered, with the one thing
 * beside them that the cut must not lose: `unusable_features`. A form answers
 * with it when its fields need a plan its account lacks. The form is saved, but
 * a respondent's submission is refused until the account upgrades, and the
 * fields are where that news arrives: dropping it left the caller thinking all
 * was well. A table never has it.
 */
function fieldListing(body: unknown, rows: Record<string, unknown>[]): Record<string, unknown> {
  const unusable = (body as { unusable_features?: unknown } | undefined)?.unusable_features;
  return { data: rows, ...(unusable === undefined ? {} : { unusable_features: unusable }) };
}

/**
 * What a field write touched, out of the whole form it answers with.
 *
 * A patch returns the container, so adding one field to a form of twenty-five
 * answers with all twenty-five and leaves the caller hunting for the api_code it
 * just created. `update` and `update-choices` name their field, so that row is
 * the answer; `add` does not get an api_code back to match on, but it does know
 * the labels it sent, and those name the rows that were not there before.
 */
function touchedFields(body: unknown, wanted: (field: Record<string, unknown>) => boolean): unknown {
  const fields = selectFields(body);
  const touched = fields.filter(wanted);
  return fieldListing(body, touched.length > 0 ? touched : fields);
}

/** The labels a field payload carries, one object or a list of them. */
function labelsOf(payload: unknown): Set<string> {
  const each = Array.isArray(payload) ? payload : [payload];
  return new Set(
    each.flatMap((item) => {
      const label = (item as { label?: unknown } | null)?.label;
      return typeof label === 'string' ? [label] : [];
    })
  );
}

/**
 * A listing is for finding the field, so each row names its operators and no
 * more. One field is for writing its condition, and a table of formats loses
 * whatever a narrow terminal has no room for, so each operator becomes its own
 * block: the format, its description, and every example as the JSON to send.
 * A reservation field is listed once for its items and once for its date, so
 * one field may be two rows, told apart by scope_attr (none, and date_time).
 */
function conditionFieldsForReading(body: unknown): unknown {
  const rows = (body as { data?: Record<string, unknown>[] }).data ?? [];
  const operatorsOf = (row: Record<string, unknown>): Record<string, unknown>[] =>
    Array.isArray(row.operators) ? (row.operators as Record<string, unknown>[]) : [];
  const oneField = rows.length > 0 && rows.every((row) => row.trigger === rows[0].trigger);
  if (!oneField) {
    return {
      data: rows.map((row) => ({
        ...row,
        operators: operatorsOf(row)
          .map((operator) => operator.operator)
          .join(' ')
      }))
    };
  }
  return Object.fromEntries(
    rows.map((row) => {
      const { operators: _operators, ...rest } = row;
      const heading = row.scope_attr ? `${row.trigger} scope_attr=${row.scope_attr}` : String(row.trigger);
      const operators = Object.fromEntries(
        operatorsOf(row).map(({ operator, examples, ...format }) => [
          operator,
          { ...format, examples: Array.isArray(examples) ? examples.map((example) => JSON.stringify(example)) : [] }
        ])
      );
      return [heading, { ...rest, operators }];
    })
  );
}

/** What `unusable_features` beside the fields means, which help says for each command that keeps it. */
const UNUSABLE_FEATURES =
  "unusable_features beside the fields means the form holds fields its account's plan cannot use: " +
  'it is saved, but respondents cannot submit it until the account upgrades.';

const WRITE_ANSWER = `Answers with the fields it touched. ${UNUSABLE_FEATURES}`;

const KIND_OPTION: OptionSpec = {
  name: '--kind',
  type: 'string',
  choices: ['form', 'table'],
  placeholder: '<kind>',
  description: 'Which container the types are for (default form)'
};

export const FIELD: readonly Command[] = [
  {
    path: ['field', 'types'],
    summary: 'List the field types a form or table can hold',
    description:
      'What to put in `type` when adding a field, and what each type accepts. `structure` is the ' +
      "part no example can carry: the keys that give a type its shape, like a table's columns or " +
      "a cascade's nesting. `settings` are the flat keys beside them, and `flags` the booleans. " +
      'A field reads back with the `type` it was written with; `read_as` is the name an older API ' +
      'version read it as, which this CLI does not ask for. ' +
      'Name one type to see its structure described in full. A table holds far fewer types ' +
      'than a form, and a scorable question type only belongs to a form that scores answers. ' +
      '`value` is what an entry writes into the type: `example` is a value it takes, exact under ' +
      '--output json, and `note` what the example cannot show.',
    args: [{ name: 'type', required: false, description: 'One type name, e.g. RadioButton' }],
    options: [
      KIND_OPTION,
      {
        name: '--scope',
        type: 'string',
        choices: FIELD_SCOPES,
        placeholder: '<scope>',
        description: `Only types of this scope: ${FIELD_SCOPES.join(', ')}`
      }
    ],
    request: (input) => {
      const query = { kind: input.options.kind as string | undefined };
      return input.args.type
        ? call('getFieldType', { path: { type: input.args.type }, query })
        : call('listFieldTypes', { query });
    },
    select: (body, input) => {
      const rows = Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: Record<string, unknown>[] }).data
        : [body as Record<string, unknown>];
      const scope = input.options.scope as string | undefined;
      return { data: scope ? rows.filter((row) => row.scope === scope) : rows };
    },
    render: fieldTypesForReading,
    examples: [
      'jinshuju field types',
      'jinshuju field types --kind table',
      'jinshuju field types --scope exam',
      'jinshuju field types CascadeDropDown'
    ]
  },
  {
    path: ['field', 'list'],
    summary: 'List the fields of a form or table',
    description:
      'The same fields `form get` and `table get` return, each in the shape `field update` takes, ' +
      `so one can be changed and sent back as it is. ${UNUSABLE_FEATURES}`,
    options: [...CONTAINER_OPTIONS],
    request: (input) => onContainer(input, 'getForm', 'getTable'),
    select: (body) => fieldListing(body, selectFields(body))
  },
  {
    path: ['field', 'filterable'],
    summary: 'List the fields a condition can test, with the operators and values each takes',
    description:
      'The fields the scope_conditions of a routine or a notification rule can name, and for each the ' +
      'operators it takes and the value each operator takes: value_format names the shape, ' +
      "value_description says it, and examples are values written with the field's own codes. " +
      'Write a condition {trigger, operator, value} as an example shows; an operator or a field not ' +
      'listed is not one a condition can use. A row with a scope_attr needs it in the condition too: a ' +
      'reservation field is listed once for its items, without one, and once for its date, with date_time. ' +
      "A routine's data trigger tests fewer fields than a notification rule: ask with --for routine. " +
      'Name a trigger to read one field in full; text clips long descriptions, --output json keeps them whole.',
    args: [{ name: 'trigger', required: false, description: 'One field, as a condition names it, e.g. field_3' }],
    options: [
      ...CONTAINER_OPTIONS,
      {
        name: '--for',
        type: 'string',
        choices: choices('listFormConditionTriggerableFields', 'fields_context'),
        placeholder: '<context>',
        description: "Only the fields a condition there can test; routine is a routine's data trigger"
      }
    ],
    request: (input) =>
      onContainer(input, 'listFormConditionTriggerableFields', 'listTableConditionTriggerableFields', {
        query: { fields_context: input.options.for as string | undefined }
      }),
    select: (body, input) => {
      const rows =
        (body as { condition_triggerable_fields?: Record<string, unknown>[] }).condition_triggerable_fields ?? [];
      const trigger = input.args.trigger;
      if (trigger === undefined) return { data: rows };
      const picked = rows.filter((row) => row.trigger === trigger);
      if (picked.length === 0) {
        throw new UsageError(`${trigger} is not a field a condition can test here; run without it to list them`);
      }
      return { data: picked };
    },
    render: conditionFieldsForReading,
    examples: [
      'jinshuju field filterable --form Kp7mQ2',
      'jinshuju field filterable --form Kp7mQ2 --for routine',
      'jinshuju field filterable --table Vn4xR8'
    ]
  },
  {
    path: ['field', 'add'],
    summary: 'Add fields to a form or table',
    description: `One field object, or a list of them. Do not pass api_code: the backend generates it. ${WRITE_ANSWER}`,
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    payload: FIELD_PAYLOAD,
    request: (input) =>
      onContainer(input, 'updateForm', 'updateTable', { body: { fields: { add: one(payload(input)) } } }),
    select: (body, input) => {
      const labels = labelsOf(payload(input));
      return touchedFields(body, (field) => labels.has(String(field.label)));
    },
    examples: ['jinshuju field add --form Kp7mQ2 --json \'{"type":"TextField","label":"备注"}\'']
  },
  {
    path: ['field', 'update'],
    summary: 'Update one field',
    description:
      'The patch is merged onto the field; the api_code comes from the argument, not the payload. ' +
      'Write the keys to change, or the whole field as `field list` read it, as the payload below says. ' +
      WRITE_ANSWER,
    args: [{ name: 'api-code', required: true, description: 'Field api_code, e.g. field_3' }],
    options: [...CONTAINER_OPTIONS, JSON_OPTION, YES_OPTION],
    payload: FIELD_PAYLOAD,
    run: async (input, client) => {
      const code = input.args['api-code'];
      const { choices: given, ...patch } = payload(input) as Record<string, unknown>;
      const fields: Record<string, unknown> = { update: [{ ...patch, api_code: code }] };
      if (Array.isArray(given)) {
        const field = selectFields(await client.request(onContainer(input, 'getForm', 'getTable'))).find(
          (candidate) => candidate.api_code === code
        );
        const current = field?.choices;
        // A type the field does not have yet, or a cascade's nested levels,
        // take the list as it is; the API replaces the choices there.
        const replaces = !field || !Array.isArray(current) || (patch.type !== undefined && patch.type !== field.type);
        if (replaces) {
          fields.update = [{ ...patch, choices: given, api_code: code }];
        } else {
          const ops = choiceOperations(current as Record<string, unknown>[], given);
          await confirmedIfHolding(
            client,
            input,
            ops.remove.map((choice) => ({ field_api_code: code, choice_value: choice.value })),
            `Choice ${ops.remove.map((choice) => JSON.stringify(choice.value)).join(', ')} of ${code}`
          );
          const operations = Object.fromEntries(
            Object.entries({ ...ops, remove: ops.remove.map((choice) => choice.api_code) }).filter(
              ([, items]) => items.length > 0
            )
          );
          if (Object.keys(patch).length === 0) delete fields.update;
          if (Object.keys(operations).length > 0) fields.update_choices = [{ ...operations, field_api_code: code }];
        }
      }
      const body = await client.request(onContainer(input, 'updateForm', 'updateTable', { body: { fields } }));
      return touchedFields(body, (candidate) => candidate.api_code === code);
    },
    examples: ['jinshuju field update --form Kp7mQ2 field_3 --json \'{"required":true}\'']
  },
  {
    path: ['field', 'update-choices'],
    summary: "Change a field's choices",
    description: `The payload is the choice operations the field takes, e.g. {add, update, remove}. ${WRITE_ANSWER}`,
    args: [{ name: 'api-code', required: true, description: 'Field api_code' }],
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    request: (input) =>
      onContainer(input, 'updateForm', 'updateTable', {
        body: {
          fields: {
            update_choices: [{ ...choiceChanges(payload(input)), field_api_code: input.args['api-code'] }]
          }
        }
      }),
    select: (body, input) => touchedFields(body, (field) => field.api_code === input.args['api-code'])
  },
  {
    path: ['field', 'check'],
    summary: 'Ask whether fields or choices already hold data',
    description:
      'The question to ask before removing one: removing a field or choice that still holds ' +
      'entries deletes those entries with it. Name a choice with <api-code>:<choice>. A shape ' +
      'this cannot express — a matrix statement, a cascade level — goes through --json.',
    args: [{ name: 'target', required: false, variadic: true, description: 'field api_code, or api_code:choice' }],
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    request: (input) =>
      onContainer(input, 'checkFormFieldData', 'checkTableFieldData', {
        query: { checks: JSON.stringify(checks(input, parseCheckTarget)) }
      }),
    examples: [
      'jinshuju field check --form Kp7mQ2 field_3 field_9',
      'jinshuju field check --form Kp7mQ2 field_7:choice_1'
    ]
  },
  {
    path: ['field', 'preview-convert'],
    summary: "Preview what changing a field's type would do to its data",
    description:
      'The conversion happens in place, so the only thing at stake is the data: this reports how ' +
      'many values are kept and how many are cleared. The edit itself is `field update <api-code> ' +
      '--json \'{"type":"TextArea"}\'`, and supported=false means that call would refuse it. ' +
      'source_type and target_type are type names as a field reads and writes them (NumberField).',
    args: [
      { name: 'api-code', required: false, description: 'Field api_code; omit it only when --json names the field' }
    ],
    options: [
      ...CONTAINER_OPTIONS,
      { name: '--to', type: 'string', placeholder: '<type>', description: 'Target field type, e.g. RadioButton' },
      {
        name: '--precision',
        type: 'string',
        placeholder: '<precision>',
        description: 'For a DateTimeField target, the precision the edit will use'
      },
      JSON_OPTION
    ],
    request: (input) => {
      // Taking --json used to drop the argument beside it without a word, and
      // the server answered about a field named nothing. One or the other.
      if (input.options.json !== undefined && input.args['api-code'] !== undefined) {
        throw new UsageError('name the field as an argument or through --json, not both');
      }
      const inline =
        input.options.json === undefined
          ? [
              {
                field_api_code: input.args['api-code'],
                target_type: requiredOption(input, 'to'),
                target_precision: input.options.precision
              }
            ]
          : one(input.options.json);
      return onContainer(input, 'previewFormFieldTypeChange', 'previewTableFieldTypeChange', {
        query: { checks: JSON.stringify(inline) }
      });
    },
    examples: ['jinshuju field preview-convert --form Kp7mQ2 field_1 --to RadioButton']
  },
  {
    path: ['field', 'remove'],
    summary: 'Remove a field',
    description:
      'Removing a field that still holds answers deletes those answers with it, and cannot be undone, ' +
      'so that one waits for --yes; a field with no answers goes without it.',
    args: [{ name: 'api-code', required: true, description: 'Field api_code' }],
    options: [...CONTAINER_OPTIONS, YES_OPTION],
    run: async (input, client) => {
      const code = input.args['api-code'];
      await confirmedIfHolding(client, input, [{ field_api_code: code }], code as string);
      return client.request(onContainer(input, 'updateForm', 'updateTable', { body: { fields: { remove: [code] } } }));
    },
    examples: ['jinshuju field remove --form Kp7mQ2 field_9', 'jinshuju field remove --form Kp7mQ2 field_9 --yes']
  }
];
