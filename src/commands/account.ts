import { LIMIT_OPTION } from '../options.js';
import { API, paging } from './shared.js';
import type { Command } from './types.js';

export const ACCOUNT: readonly Command[] = [
  {
    path: ['account', 'get'],
    summary: 'Show the current account, plan and quota',
    request: () => ({ method: 'GET', path: `${API}/billing_account` })
  },
  {
    path: ['account', 'member', 'list'],
    summary: 'List account members',
    options: [LIMIT_OPTION],
    request: (input) => ({ method: 'GET', path: `${API}/billing_account/users`, query: paging(input) })
  }
];
