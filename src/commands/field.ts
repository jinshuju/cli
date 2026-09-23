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
      'What to put in `type` when adding a field, and what each type accepts. `takes_choices` says whether the field carries choices; `flags` are the booleans the payload may set on it; `settings` are the keys that type understands beyond the common ones. A table holds far fewer types than a form.',
    args: [{ name: 'type', required: false, description: 'One type name, e.g. RadioButton' }],
    options: [KIND_OPTION],
    request: (input) => ({
      method: 'GET',
      path: input.args.type ? `${API}/field_types/${input.args.type}` : `${API}/field_types`,
      query: { kind: input.options.kind as string | undefined }
    }),
    select: (body) => (Array.isArray((body as { data?: unknown }).data) ? body : { data: [body] }),
    examples: ['jinshuju field types', 'jinshuju field types --kind table', 'jinshuju field types RadioButton']
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
    })
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
      'many values are kept and how many are cleared. supported=false means the edit would refuse it.',
    args: [{ name: 'api-code', required: true, description: 'Field api_code' }],
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
