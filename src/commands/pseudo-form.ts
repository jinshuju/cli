import { UsageError } from '../errors.js';
import { JSON_OPTION, PAGINATION_OPTIONS, type OptionSpec } from '../options.js';
import { call } from '../spec.js';
import { FORM_OPTION, LISTING, YES_OPTION, confirmed, given, paging, requiredOption } from './shared.js';
import type { Command, CommandInput } from './types.js';

const NAME_OPTION: OptionSpec = {
  name: '--name',
  type: 'string',
  placeholder: '<name>',
  description: 'Name shown in the form’s pseudo form list, e.g. who the link is for'
};

const VALUES_PAYLOAD = [
  '{ "field_1": "张三", "field_3": "研发部" }',
  '',
  'Keyed by field api_code, as `jinshuju field list --form <token>` lists them, each value written as',
  '`entry create` writes it: a choice by its code or its text. Not every type can be preset; one that',
  'cannot, such as an attachment, is refused by name.'
];

function formPath(input: CommandInput): { form_token: string } {
  return { form_token: requiredOption(input, 'form') };
}

function batchItems(input: CommandInput): unknown[] {
  const items = input.options.batch;
  if (input.options.json !== undefined || input.options.name !== undefined) {
    throw new UsageError('--batch carries each item’s name and values; it does not go with --json or --name');
  }
  if (!Array.isArray(items)) throw new UsageError('--batch must be a list of {"name", "values"}');
  return items;
}

export const PSEUDO_FORM: readonly Command[] = [
  {
    path: ['pseudo-form', 'list'],
    summary: 'List the pseudo forms (prefilled links) of a form, newest first',
    description: 'The ones made in the web app are listed too. fill_url is the link to hand out.',
    options: [FORM_OPTION, ...PAGINATION_OPTIONS],
    request: (input) => call('listPseudoForms', { path: formPath(input), query: paging(input) }),
    paginate: LISTING,
    examples: ['jinshuju pseudo-form list --form Kp7mQ2']
  },
  {
    path: ['pseudo-form', 'create'],
    summary: 'Create a pseudo form: a fill link with some fields already filled in',
    description:
      'The answer’s fill_url is the link to hand out; an entry submitted through it keeps the preset values ' +
      'whatever the filler types. --batch makes one link per item, up to 200 in a request: the items it ' +
      'could not make come back in errors by index, and the rest are made. Only a manager of the form can.',
    options: [
      FORM_OPTION,
      NAME_OPTION,
      JSON_OPTION,
      {
        name: '--batch',
        type: 'json',
        placeholder: '<json|@file|->',
        description: 'One pseudo form per item, up to 200: [{"name": "...", "values": {...}}]'
      }
    ],
    payload: VALUES_PAYLOAD,
    request: (input) => {
      if (input.options.batch !== undefined) {
        return call('createPseudoFormsBatch', { path: formPath(input), body: { pseudo_forms: batchItems(input) } });
      }
      const values = input.options.json;
      if (values === undefined) throw new UsageError('--json is required: the preset values, keyed by api_code');
      return call('createPseudoForm', { path: formPath(input), body: given({ name: input.options.name, values }) });
    },
    examples: [
      'jinshuju pseudo-form create --form Kp7mQ2 --name 张三-上司 --json \'{"field_1":"张三","field_2":"上司"}\'',
      'jinshuju pseudo-form create --form Kp7mQ2 --batch @links.json'
    ]
  },
  {
    path: ['pseudo-form', 'edit'],
    summary: 'Rename a pseudo form or change its preset values',
    description:
      'Only what is named changes: the fields in --json take the new values, a field set to null loses its ' +
      'preset, and the fields left out keep theirs. The fill link stays the same.',
    args: [
      { name: 'pseudo-form', required: true, description: 'Pseudo form token, the end of its fill_url (/pf/<token>)' }
    ],
    options: [FORM_OPTION, NAME_OPTION, JSON_OPTION],
    payload: VALUES_PAYLOAD,
    request: (input) => {
      const body = given({ name: input.options.name, values: input.options.json });
      if (Object.keys(body).length === 0) throw new UsageError('Nothing to change: pass --name, --json or both');
      return call('updatePseudoForm', {
        path: { ...formPath(input), pseudo_form_token: input.args['pseudo-form'] },
        body
      });
    },
    examples: ['jinshuju pseudo-form edit aB3dE9 --form Kp7mQ2 --json \'{"field_2":null}\'']
  },
  {
    path: ['pseudo-form', 'delete'],
    summary: 'Delete pseudo forms; their fill links stop working',
    description:
      'Several tokens go in one request, up to 200; the ones that name none of the form’s pseudo forms ' +
      'come back in not_found_tokens.',
    args: [{ name: 'pseudo-form', required: true, variadic: true, description: 'Pseudo form token(s)' }],
    options: [FORM_OPTION, YES_OPTION],
    request: (input) => {
      const tokens = input.rest;
      confirmed(
        input,
        `Deleting ${tokens.length === 1 ? `pseudo form ${tokens[0]}` : `${tokens.length} pseudo forms`}`
      );
      if (tokens.length === 1) {
        return call('deletePseudoForm', { path: { ...formPath(input), pseudo_form_token: tokens[0] } });
      }
      return call('deletePseudoFormsBatch', { path: formPath(input), body: { tokens } });
    },
    examples: ['jinshuju pseudo-form delete aB3dE9 Xy7Kp2 --form Kp7mQ2 --yes']
  }
];
