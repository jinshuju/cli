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
    path: ['account', 'me'],
    summary: 'Show who is signed in: name, email, mobile and role in the account',
    request: () => ({ method: 'GET', path: `${API}/me` })
  },
  {
    path: ['account', 'member', 'list'],
    summary: 'List account members',
    options: [LIMIT_OPTION],
    request: (input) => ({ method: 'GET', path: `${API}/billing_account/users`, query: paging(input) })
  },
  {
    path: ['account', 'invoice', 'list'],
    summary: 'List e-invoices, and the amount not invoiced yet',
    description: 'Account admins only, as in the web app; a member is refused with 403.',
    request: () => ({ method: 'GET', path: `${API}/billing_account/invoices` })
  },
  {
    path: ['account', 'payment', 'list'],
    summary: 'List what the account spent or topped up on 金数据: SMS, AI points, plans, recharges',
    description:
      'Not what its payment forms collected from customers: that is transaction list. Newest first. ' +
      'Account admins only, as in the web app; a member is refused with 403.',
    options: [
      { name: '--from', type: 'string', placeholder: '<YYYY-MM-DD>', description: 'First day' },
      { name: '--to', type: 'string', placeholder: '<YYYY-MM-DD>', description: 'Last day, inclusive' },
      {
        name: '--verb',
        type: 'string',
        placeholder: '<verb>',
        description: 'Only this kind of record, e.g. sms_charge'
      },
      { ...LIMIT_OPTION, description: 'Records to return (default 50, up to 1000)' },
      { name: '--with-balance', type: 'boolean', description: 'Also return the current balance and quotas' }
    ],
    request: (input) => ({
      method: 'GET',
      path: `${API}/billing_account/payment_histories`,
      query: {
        start_date: input.options.from as string | undefined,
        end_date: input.options.to as string | undefined,
        verb: input.options.verb as string | undefined,
        limit: input.options.limit === undefined ? undefined : String(input.options.limit),
        include_balance: input.options.with_balance ? 'true' : undefined
      }
    })
  }
];
