import { LIMIT_OPTION } from '../options.js';
import { call } from '../spec.js';
import { paging } from './shared.js';
import type { Command } from './types.js';

export const ACCOUNT: readonly Command[] = [
  {
    path: ['account', 'get'],
    summary: 'Show the current account, plan and quota',
    request: () => call('getBillingAccount')
  },
  {
    path: ['account', 'me'],
    summary: 'Show who is signed in: name, email, mobile and role in the account',
    request: () => call('getCurrentUser')
  },
  {
    path: ['account', 'member', 'list'],
    summary: 'List account members',
    options: [LIMIT_OPTION],
    request: (input) => call('listBillingAccountUsers', { query: paging(input) })
  },
  {
    path: ['account', 'feature', 'list'],
    summary: 'List what the account can use now: entries, attachments, reminders, payments, public search, AI points',
    description:
      'For each feature: whether it is available, why not, how to unlock it ' +
      '(upgrade the plan, buy a package, apply for a 小金商户 or bind a payment account), and the quota left this month.',
    request: () => call('listBillingAccountFeatures')
  },
  {
    path: ['account', 'invoice', 'list'],
    summary: 'List e-invoices, and the amount not invoiced yet',
    description: 'Account admins only, as in the web app; a member is refused with 403.',
    request: () => call('listBillingAccountInvoices')
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
    request: (input) =>
      call('listBillingAccountPaymentHistories', {
        query: {
          start_date: input.options.from as string | undefined,
          end_date: input.options.to as string | undefined,
          verb: input.options.verb as string | undefined,
          limit: input.options.limit as number | undefined,
          include_balance: input.options.with_balance ? true : undefined
        }
      })
  }
];
