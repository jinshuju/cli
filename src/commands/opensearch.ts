import { JSON_OPTION, UsageError } from '../options.js';
import { API, overriding, payload } from './shared.js';
import type { Command } from './types.js';

export const OPENSEARCH: readonly Command[] = [
  {
    path: ['opensearch', 'list'],
    summary: 'List public queries',
    options: [{ name: '--form', type: 'string', placeholder: '<token>', description: 'Only the queries of this form' }],
    request: (input) => ({
      method: 'GET',
      path: `${API}/opensearch/queries`,
      query: { form_token: input.options.form as string | undefined }
    })
  },
  {
    path: ['opensearch', 'get'],
    summary: 'Show a public query',
    args: [{ name: 'query', required: true, description: 'Public query token' }],
    request: (input) => ({ method: 'GET', path: `${API}/opensearch/queries/${input.args.query}` })
  },
  {
    path: ['opensearch', 'fields'],
    summary: 'Suggest the fields a public query can use',
    options: [{ name: '--form', type: 'string', placeholder: '<token>', description: 'Form token' }],
    request: (input) => {
      const form = input.options.form as string | undefined;
      if (!form) throw new UsageError('--form <token> is required');
      return { method: 'GET', path: `${API}/opensearch/query_suggestions`, query: { form_token: form } };
    }
  },
  {
    path: ['opensearch', 'create'],
    summary: 'Create a public query',
    description: 'Ask `opensearch fields --form <token>` which fields a query may search on and return.',
    options: [
      { name: '--form', type: 'string', placeholder: '<token>', description: 'Form the query reads' },
      JSON_OPTION
    ],
    request: (input) => {
      const form = input.options.form as string | undefined;
      if (!form) throw new UsageError('--form <token> is required');
      return {
        method: 'POST',
        path: `${API}/opensearch/queries`,
        body: overriding(payload(input) as Record<string, unknown>, { form_token: form })
      };
    }
  },
  {
    path: ['opensearch', 'edit'],
    summary: 'Edit a public query, or turn it on and off',
    args: [{ name: 'query', required: true, description: 'Public query token' }],
    options: [
      JSON_OPTION,
      { name: '--enable', type: 'boolean', description: 'Turn the query on' },
      { name: '--disable', type: 'boolean', description: 'Turn the query off' }
    ],
    request: (input) => {
      if (input.options.enable && input.options.disable) {
        throw new UsageError('--enable and --disable are opposites, pass one');
      }
      const rest = (input.options.json as Record<string, unknown> | undefined) ?? {};
      const enabled = input.options.enable ? true : input.options.disable ? false : undefined;
      return {
        method: 'PATCH',
        path: `${API}/opensearch/queries/${input.args.query}`,
        body: overriding(rest, { enabled })
      };
    },
    examples: ['jinshuju opensearch edit Qy7nR3 --disable']
  }
];
