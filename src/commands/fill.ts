import { UsageError } from '../errors.js';
import type { HttpRequest } from '../http.js';
import { JSON_OPTION } from '../options.js';
import { call, type CallParts, type OperationId } from '../spec.js';
import type { ArgSpec, Command, CommandInput } from './types.js';

/**
 * The two kinds of fill page: `/f/<token>` for a form, `/v/<token>` for a
 * table's form view. The API mirrors them as two operations each, so a link is
 * all it takes to know which.
 */
const ROUTES: Record<string, { token: string; page: OperationId; submit: OperationId }> = {
  f: { token: 'form_token', page: 'getFillFormPage', submit: 'createFillFormEntry' },
  v: { token: 'view_token', page: 'getFillViewPage', submit: 'createFillViewEntry' }
};

const PAGE_ARG: ArgSpec = {
  name: 'page',
  required: true,
  description: 'The fill link as shared, e.g. https://example.jinshuju.net/v/aB3dE9, or just its path: v/aB3dE9'
};

/** The page's or the submit's request for a fill link, or for the `f/…` / `v/…` path of one. */
function fillPage(input: CommandInput, what: 'page' | 'submit', parts: CallParts = {}): HttpRequest {
  const page = input.args.page.trim();
  let path = page;
  if (/^https?:\/\//i.test(page)) {
    try {
      path = new URL(page).pathname;
    } catch {
      throw new UsageError(`Not a link: ${page}`);
    }
  }
  const [route, token] = path.split('/').filter(Boolean);
  const kind = route !== undefined && Object.hasOwn(ROUTES, route) ? ROUTES[route] : undefined;
  if (!kind || !token) {
    throw new UsageError(`Not a fill link: ${page}. A fill link ends in /f/<token> or /v/<token>.`);
  }
  return call(kind[what], { ...parts, path: { [kind.token]: token } });
}

export const FILL: readonly Command[] = [
  {
    path: ['fill', 'get'],
    summary: 'Show what a fill page asks for, and whether you can submit to it',
    description:
      'Reads the page as anyone with its link would: no role on the form or table is needed, and only what ' +
      'the page shows its fillers comes back. `status.key` is `open` when you can submit. `blockers` lists ' +
      'what only the person at the page can do — a captcha, an SMS code, WeChat, a payment — and while it is ' +
      'not empty the page has to be filled in a browser. `manageable` appears only when you could already ' +
      'read the form or table behind the page.',
    args: [PAGE_ARG],
    request: (input) => fillPage(input, 'page'),
    examples: ['jinshuju fill get https://example.jinshuju.net/v/aB3dE9', 'jinshuju fill get f/Kp7mQ2']
  },
  {
    path: ['fill', 'submit'],
    summary: 'Submit an entry through a fill page',
    description:
      'Submits as you, the way the page’s submit button does: only the fields the page shows are taken, the ' +
      'page’s required set applies, and the entry is recorded as yours. The payload is keyed by field ' +
      'api_code, as `fill get` lists them.',
    args: [PAGE_ARG],
    options: [
      JSON_OPTION,
      { name: '--password', type: 'string', placeholder: '<password>', description: 'The page’s access password' }
    ],
    payload: [
      '{ "field_1": "张三", "field_2": "Abc1" }',
      '',
      'Each type takes a value of its own shape — a choice by its code, as `fill get` lists them —',
      'and `jinshuju field types <Type>` shows it under `value`.'
    ],
    request: (input) => {
      const entry = input.options.json;
      if (entry === undefined) throw new UsageError('--json is required: the values to submit, keyed by api_code');
      const body: Record<string, unknown> = { entry };
      if (input.options.password !== undefined) body.password = input.options.password;
      return fillPage(input, 'submit', { body });
    },
    examples: ['jinshuju fill submit https://example.jinshuju.net/v/aB3dE9 --json \'{"field_1":"张三"}\'']
  }
];
