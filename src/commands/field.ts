import { CONTAINER_OPTIONS, JSON_OPTION, UsageError, type OptionSpec } from '../options.js';
import { API, YES_OPTION, confirmed, containerPath, one, payload, requiredOption } from './shared.js';
import type { Command, CommandInput } from './types.js';

/** One field, or a list of them — the same objects `fields` holds above. */
const FIELD_PAYLOAD: readonly string[] = [
  '{ "type": "TextField", "label": "Notes", "required": false }',
  '',
  'Field types: jinshuju field types'
];

/**
 * A form's fields arrive as one object per field, keyed by api_code. A list of
 * fields is what a caller asked for, so it is a list here, with the api_code
 * alongside the rest rather than hidden in the key.
 */
function selectFields(body: unknown): Record<string, unknown>[] {
  const fields = (body as { fields?: Record<string, Record<string, unknown>>[] } | undefined)?.fields ?? [];
  return fields.flatMap((entry) =>
    Object.entries(entry).map(([api_code, attributes]) => ({ api_code, ...attributes }))
  );
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
  return { data: touched.length > 0 ? touched : fields };
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
      "a cascade's nesting. `settings` are the flat keys beside them, `flags` the booleans, and " +
      '`read_as` the name the same field answers with when read back — which is not the name you ' +
      'write. Name one type to see its structure described in full. A table holds far fewer types ' +
      'than a form, and a scorable question type only belongs to a form that scores answers.',
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
    request: (input) => ({
      method: 'GET',
      path: input.args.type ? `${API}/field_types/${input.args.type}` : `${API}/field_types`,
      query: { kind: input.options.kind as string | undefined }
    }),
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
    description: 'Read out of the object structure, the same fields `form get` and `table get` return.',
    options: [...CONTAINER_OPTIONS],
    request: (input) => ({ method: 'GET', path: containerPath(input) }),
    select: (body) => ({ data: selectFields(body) })
  },
  {
    path: ['field', 'add'],
    summary: 'Add fields to a form or table',
    description: 'One field object, or a list of them. Do not pass api_code: the backend generates it.',
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    payload: FIELD_PAYLOAD,
    request: (input) => ({
      method: 'PATCH',
      path: containerPath(input),
      body: { fields: { add: one(payload(input)) } }
    }),
    select: (body, input) => {
      const labels = labelsOf(payload(input));
      return touchedFields(body, (field) => labels.has(String(field.label)));
    },
    examples: ['jinshuju field add --form Kp7mQ2 --json \'{"type":"TextField","label":"备注"}\'']
  },
  {
    path: ['field', 'update'],
    summary: 'Update one field',
    description: 'The patch is merged onto the field; the api_code comes from the argument, not the payload.',
    args: [{ name: 'api-code', required: true, description: 'Field api_code, e.g. field_3' }],
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: containerPath(input),
      body: {
        fields: { update: [{ ...(payload(input) as Record<string, unknown>), api_code: input.args['api-code'] }] }
      }
    }),
    select: (body, input) => touchedFields(body, (field) => field.api_code === input.args['api-code']),
    examples: ['jinshuju field update --form Kp7mQ2 field_3 --json \'{"required":true}\'']
  },
  {
    path: ['field', 'update-choices'],
    summary: "Change a field's choices",
    description: 'The payload is the choice operations the field takes, e.g. {add, update, remove}.',
    args: [{ name: 'api-code', required: true, description: 'Field api_code' }],
    options: [...CONTAINER_OPTIONS, JSON_OPTION],
    request: (input) => ({
      method: 'PATCH',
      path: containerPath(input),
      body: {
        fields: {
          update_choices: [{ ...(payload(input) as Record<string, unknown>), field_api_code: input.args['api-code'] }]
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
    request: (input) => ({
      method: 'GET',
      path: `${containerPath(input)}/fields/check`,
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
      'source_type and target_type are write names (NumberField), not the names a read answers with.',
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
      return {
        method: 'GET',
        path: `${containerPath(input)}/fields/preview_convert`,
        query: { checks: JSON.stringify(inline) }
      };
    },
    examples: ['jinshuju field preview-convert --form Kp7mQ2 field_1 --to RadioButton']
  },
  {
    path: ['field', 'remove'],
    summary: 'Remove a field',
    description: 'Removing a field that still holds answers deletes those answers with it, and cannot be undone.',
    args: [{ name: 'api-code', required: true, description: 'Field api_code' }],
    options: [...CONTAINER_OPTIONS, YES_OPTION],
    request: (input) => {
      confirmed(input, `Removing ${input.args['api-code']} and any answers it holds`);
      return { method: 'PATCH', path: containerPath(input), body: { fields: { remove: [input.args['api-code']] } } };
    },
    examples: ['jinshuju field remove --form Kp7mQ2 field_9 --yes']
  }
];
