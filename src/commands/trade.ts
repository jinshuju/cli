import { PAGINATION_OPTIONS, type OptionSpec } from '../options.js';
import { call, choices, type OperationId, type QueryValue } from '../spec.js';
import { paging } from './shared.js';
import type { Command, CommandInput } from './types.js';

/**
 * The account's 小金商户: what its payment forms collected, refunded and paid
 * out. An account collecting through its own bound WeChat / Alipay merchant
 * (直连) has none of this in 金数据, and the reads below say so rather than
 * answering with zeroes.
 */

const DATE_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--from',
    type: 'string',
    placeholder: '<YYYY-MM-DD>',
    description: 'First day, Asia/Shanghai; give it with --to'
  },
  { name: '--to', type: 'string', placeholder: '<YYYY-MM-DD>', description: 'Last day, inclusive; give it with --from' }
];

/**
 * The CLI spells a dimension as its flag is spelled; the API names it by its
 * parameter, and the spec says which of those it groups by.
 */
const GROUP_BY: Record<string, string> = { time: 'time', 'paid-status': 'paid_status', channel: 'payment_channel' };

const ORDER_FILTER_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--status',
    type: 'string',
    repeatable: true,
    choices: choices('listTradeTransactions', 'paid_status'),
    placeholder: '<status>',
    description: 'Keep only these payment statuses, repeatable. Omitted, every status, unpaid included'
  },
  {
    name: '--channel',
    type: 'string',
    choices: choices('listTradeTransactions', 'payment_channel'),
    placeholder: '<channel>',
    description: 'Keep only orders paid through this channel: wxpay (微信) or alipay (支付宝)'
  },
  { name: '--form', type: 'string', placeholder: '<token>', description: 'Keep only orders of this payment form' }
];

/** What a refund or payout listing carries, as the operation behind it allows. */
function includeOption(id: OperationId): OptionSpec {
  return {
    name: '--include',
    type: 'string',
    choices: choices(id, 'include'),
    placeholder: '<what>',
    description: 'both (default), stats for the statistics alone, or records for the rows alone'
  };
}

/** Which state a refund or a payout is in, as the operation behind it names them. */
function recordStatusOption(id: OperationId, what: string): OptionSpec {
  return {
    name: '--status',
    type: 'string',
    choices: choices(id, 'status'),
    placeholder: '<status>',
    description: `Keep only ${what} in this state`
  };
}

const DETAIL_LIMITS =
  'Rows are capped at 90 days and 200 matching records per query; past either, no rows come back, ' +
  'only detail_limit and the stats for the whole range. Narrow the range rather than splitting it.';

function dates(input: CommandInput): Record<string, string | undefined> {
  return {
    start_date: input.options.from as string | undefined,
    end_date: input.options.to as string | undefined
  };
}

function orderFilters(input: CommandInput): Record<string, QueryValue> {
  const statuses = (input.options.status as string[] | undefined) ?? [];
  return {
    paid_status: statuses.length > 0 ? statuses : undefined,
    payment_channel: input.options.channel as string | undefined,
    form_token: input.options.form as string | undefined
  };
}

export const TRADE: readonly Command[] = [
  {
    path: ['merchant', 'get'],
    summary: 'Show the 小金商户: where onboarding stands, balance, rate and settlement account',
    description:
      'Answers without a merchant too: merchant_stage says where the application stands. Bank card, phone, ' +
      'email and ID numbers come back masked, as the product shows them.',
    request: () => call('getTradeMerchant')
  },
  {
    path: ['transaction', 'list'],
    summary: 'List payment orders customers placed on payment forms',
    description:
      'Defaults to the last 90 days; --order-no alone searches all time. ' +
      DETAIL_LIMITS +
      ' For totals or a breakdown, use transaction aggregate instead of adding up rows.',
    options: [
      ...DATE_OPTIONS,
      ...ORDER_FILTER_OPTIONS,
      {
        name: '--order-no',
        type: 'string',
        placeholder: '<no>',
        description: 'Exact match on 交易单号, 商户订单号 or 金数据单号'
      },
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listTradeTransactions', {
        query: {
          ...dates(input),
          ...orderFilters(input),
          order_no: input.options.order_no as string | undefined,
          ...paging(input)
        }
      }),
    paginate: { items: 'transactions', cursor: 'next' },
    examples: [
      'jinshuju transaction list --from 2026-09-01 --to 2026-09-28',
      'jinshuju transaction list --order-no 1234567890',
      'jinshuju transaction list --form Kp7mQ2 --status refunded --status partial_refunded --all'
    ]
  },
  {
    path: ['transaction', 'aggregate'],
    summary: 'Total the payment orders: amount, paid count and order count, optionally grouped',
    description:
      'Defaults to the last 30 days, up to 366. The totals cover the whole range whatever the paging of a listing.',
    options: [
      ...DATE_OPTIONS,
      {
        name: '--group-by',
        type: 'string',
        choices: Object.keys(GROUP_BY),
        placeholder: '<dimension>',
        description: 'Break the totals down by one dimension; time picks day, week or month from the span'
      },
      ...ORDER_FILTER_OPTIONS
    ],
    request: (input) =>
      call('aggregateTradeTransactions', {
        query: { ...dates(input), group_by: GROUP_BY[input.options.group_by as string], ...orderFilters(input) }
      }),
    examples: ['jinshuju transaction aggregate --from 2026-09-01 --to 2026-09-28 --group-by channel']
  },
  {
    path: ['refund', 'list'],
    summary: 'List refunds, with their statistics',
    description: 'Defaults to the last 90 days; --refund-no alone searches all time. ' + DETAIL_LIMITS,
    options: [
      ...DATE_OPTIONS,
      recordStatusOption('listTradeRefunds', 'refunds'),
      { name: '--refund-no', type: 'string', placeholder: '<no>', description: 'Exact match on 退款流水号' },
      includeOption('listTradeRefunds'),
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listTradeRefunds', {
        query: {
          ...dates(input),
          status: input.options.status as string | undefined,
          refund_no: input.options.refund_no as string | undefined,
          include: input.options.include as string | undefined,
          ...paging(input)
        }
      }),
    paginate: { items: 'refunds', cursor: 'next' }
  },
  {
    path: ['payout', 'list'],
    summary: 'List payouts (提现) to the settlement account, with their statistics',
    description: 'Defaults to the last 90 days. ' + DETAIL_LIMITS,
    options: [
      ...DATE_OPTIONS,
      recordStatusOption('listTradePayouts', 'payouts'),
      includeOption('listTradePayouts'),
      ...PAGINATION_OPTIONS
    ],
    request: (input) =>
      call('listTradePayouts', {
        query: {
          ...dates(input),
          status: input.options.status as string | undefined,
          include: input.options.include as string | undefined,
          ...paging(input)
        }
      }),
    paginate: { items: 'payouts', cursor: 'next' }
  }
];
