import { PAGINATION_OPTIONS, type OptionSpec } from '../options.js';
import { API, paging } from './shared.js';
import type { Command, CommandInput } from './types.js';

/**
 * The account's 小金商户: what its payment forms collected, refunded and paid
 * out. An account collecting through its own bound WeChat / Alipay merchant
 * (直连) has none of this in 金数据, and the reads below say so rather than
 * answering with zeroes.
 */

const PAID_STATUSES = ['paid', 'unpaid', 'refunded', 'refunding', 'partial_refunded'];
const RECORD_STATUSES = ['processing', 'success', 'error'];

const DATE_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--from',
    type: 'string',
    placeholder: '<YYYY-MM-DD>',
    description: 'First day, Asia/Shanghai; give it with --to'
  },
  { name: '--to', type: 'string', placeholder: '<YYYY-MM-DD>', description: 'Last day, inclusive; give it with --from' }
];

/** The CLI spells a dimension as its flag is spelled; the API names it by its parameter. */
const GROUP_BY: Record<string, string> = { time: 'time', 'paid-status': 'paid_status', channel: 'payment_channel' };

const ORDER_FILTER_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--status',
    type: 'string',
    repeatable: true,
    choices: PAID_STATUSES,
    placeholder: '<status>',
    description: 'Keep only these payment statuses, repeatable. Omitted, every status, unpaid included'
  },
  {
    name: '--channel',
    type: 'string',
    choices: ['wxpay', 'alipay'],
    placeholder: '<channel>',
    description: 'Keep only orders paid through this channel: wxpay (微信) or alipay (支付宝)'
  },
  { name: '--form', type: 'string', placeholder: '<token>', description: 'Keep only orders of this payment form' }
];

const INCLUDE_OPTION: OptionSpec = {
  name: '--include',
  type: 'string',
  choices: ['both', 'stats', 'records'],
  placeholder: '<what>',
  description: 'both (default), stats for the statistics alone, or records for the rows alone'
};

const DETAIL_LIMITS =
  'Rows are capped at 90 days and 200 matching records per query; past either, no rows come back, ' +
  'only detail_limit and the stats for the whole range. Narrow the range rather than splitting it.';

function dates(input: CommandInput): Record<string, string | undefined> {
  return {
    start_date: input.options.from as string | undefined,
    end_date: input.options.to as string | undefined
  };
}

function orderFilters(input: CommandInput): Record<string, string | readonly string[] | undefined> {
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
    request: () => ({ method: 'GET', path: `${API}/trade/merchant` })
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
    request: (input) => ({
      method: 'GET',
      path: `${API}/trade/transactions`,
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
    request: (input) => ({
      method: 'GET',
      path: `${API}/trade/transactions/aggregate`,
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
      {
        name: '--status',
        type: 'string',
        choices: RECORD_STATUSES,
        placeholder: '<status>',
        description: 'Keep only refunds in this state'
      },
      { name: '--refund-no', type: 'string', placeholder: '<no>', description: 'Exact match on 退款流水号' },
      INCLUDE_OPTION,
      ...PAGINATION_OPTIONS
    ],
    request: (input) => ({
      method: 'GET',
      path: `${API}/trade/refunds`,
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
      {
        name: '--status',
        type: 'string',
        choices: RECORD_STATUSES,
        placeholder: '<status>',
        description: 'Keep only payouts in this state'
      },
      INCLUDE_OPTION,
      ...PAGINATION_OPTIONS
    ],
    request: (input) => ({
      method: 'GET',
      path: `${API}/trade/payouts`,
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
