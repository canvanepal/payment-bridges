import type { SessionPayload } from './types';

export const STORES_PAGEABLE = { currentPage: 1, rowPerPage: 10 };
export const REPORT_PAGEABLE = { currentPage: 1, rowPerPage: 10, paginated: true, enable: true };

/**
 * How much of the caller's identity gets written into the upstream body.
 *
 * - `full`         merchantCode plus the identity block (almost every endpoint)
 * - `merchantCode` merchantCode only (the recent-transactions call)
 * - `none`         neither — for lookups that are not merchant-scoped, like the
 *                  bank and refund-reason reference lists
 */
export type IdentityMode = 'full' | 'merchantCode' | 'none';

export interface RouteSpec {
  /** Bridge path, appended to `/api`. */
  path: string;
  /** Upstream path under `/backend/api`. */
  upstream: string;
  /** Defaults to POST; only reference lookups are GET. */
  method?: 'GET' | 'POST';
  /** Body key that carries the identity block. Most endpoints use `userDetail`. */
  contextKey?: 'userDetail' | 'requestUserDetailDto';
  identity?: IdentityMode;
  /** Set false to omit merchantCode while still injecting the identity block. */
  includeMerchantCode?: boolean;
  defaults?: Record<string, unknown>;
  /** One-line description, surfaced by `GET /api` and in the test console. */
  title?: string;
}

/**
 * Curated surface, mirroring what the merchant portal itself calls — the paths
 * and bodies were read out of the portal's own route table and request builders.
 *
 * The caller sends only business inputs; the Worker injects `merchantCode` and the
 * identity block from the sealed session, so a caller can never widen the scope to
 * another merchant.
 */
export const POST_ROUTES: RouteSpec[] = [
  /* --- dashboard ------------------------------------------------------- */
  {
    path: '/dashboard/balance',
    upstream: '/backend/api/dashboard/transaction/settle-unsettle',
    title: 'Settled / unsettled totals (the dashboard balance cards)',
  },
  {
    path: '/dashboard/transactions',
    upstream: '/backend/api/dashboard/transaction/list',
    title: 'Recent transactions for the merchant',
  },
  {
    path: '/dashboard/settlement',
    upstream: '/backend/api/dashboard/transaction/settlement',
    title: 'Settlement statistic (upstream returns 400 for a quiet merchant)',
  },
  {
    path: '/dashboard/images',
    upstream: '/backend/api/dashboard/images',
    method: 'GET',
    identity: 'none',
    title: 'Dashboard card images',
  },

  /* --- stores and terminals ------------------------------------------- */
  {
    path: '/stores',
    upstream: '/backend/api/merchant/stores/list',
    defaults: { pageable: STORES_PAGEABLE },
    title: 'Merchant store list',
  },
  {
    path: '/stores/search',
    upstream: '/backend/api/merchant/stores/store-label',
    defaults: { pageable: STORES_PAGEABLE },
    title: 'Search stores by label',
  },
  {
    path: '/stores/summary',
    upstream: '/backend/api/merchant/stores/terminal/store-label-selected',
    defaults: { storeLabel: 'Store1', terminal: '' },
    title: 'Store totals: transaction and amount rollups',
  },
  {
    path: '/stores/terminals',
    upstream: '/backend/api/merchant/stores/terminal/store-label',
    defaults: { pageable: STORES_PAGEABLE },
    title: 'Terminals belonging to a store',
  },

  /* --- QR -------------------------------------------------------------- */
  {
    path: '/qr',
    upstream: '/backend/api/nqr/generate',
    defaults: { storeLabel: 'Store1', terminal: '', amount: 1, remarks: 'test' },
    title: 'Dynamic QR for an amount — returns qrString plus a websocket URL',
  },
  {
    path: '/qr/store',
    upstream: '/backend/api/stores/nqr/generate',
    defaults: { storeLabel: 'Store1' },
    title: 'Static QR for a store',
  },
  {
    path: '/qr/terminal',
    upstream: '/backend/api/stores/terminal/nqr/generate',
    defaults: { storeLabel: 'Store1', terminal: '' },
    title: 'Static QR for a terminal',
  },

  /* --- reports --------------------------------------------------------- */
  {
    path: '/reports/transactions',
    upstream: '/backend/api/report/transaction/list',
    defaults: {
      fromDate: '',
      toDate: '',
      storeLabel: '',
      terminal: '',
      nqrTxnId: '',
      payerMobileNumber: '',
      issuerNetwork: '',
      pageable: REPORT_PAGEABLE,
    },
    title: 'Transaction report for a date range',
  },
  {
    path: '/reports/summary',
    upstream: '/backend/api/report/summary/list',
    defaults: { fromDate: '', toDate: '', storeLabel: '', terminal: '', issuerNetwork: '', pageable: REPORT_PAGEABLE },
    title: 'Summary report for a date range',
  },
  {
    path: '/reports/network',
    upstream: '/backend/api/report/network/list',
    contextKey: 'requestUserDetailDto',
    includeMerchantCode: false,
    title: 'Issuer network report',
  },
  {
    path: '/reports/refunds',
    upstream: '/backend/api/report/refund/list',
    defaults: { txnStatus: '', payerMobileNumber: '', fromDate: '', toDate: '', pageable: REPORT_PAGEABLE },
    title: 'Refund report for a date range',
  },
  {
    path: '/reports/settlements',
    upstream: '/backend/api/report/settlement/list',
    defaults: { fromDate: '', toDate: '', issuerNetwork: '', pageable: REPORT_PAGEABLE },
    title: 'Settlement report for a date range',
  },

  /* --- refunds --------------------------------------------------------- */
  {
    path: '/refunds',
    upstream: '/backend/api/refund/transaction/list',
    defaults: { nqrTxnId: '', payerMobileNumber: '', fromDate: '', toDate: '', pageable: REPORT_PAGEABLE },
    title: 'Refundable transactions (maker view)',
  },
  {
    path: '/refunds/reasons',
    upstream: '/backend/api/refund/reason',
    method: 'GET',
    identity: 'none',
    title: 'Reference: refund reason codes',
  },

  /* --- users and reference data --------------------------------------- */
  {
    path: '/users',
    upstream: '/backend/api/v1/users/list',
    defaults: { username: '', mobileNumber: '', pageable: REPORT_PAGEABLE },
    title: 'Portal users for the merchant',
  },
  {
    path: '/users/roles',
    upstream: '/backend/api/v1/users/role',
    method: 'GET',
    identity: 'none',
    title: 'Reference: assignable roles',
  },
  {
    path: '/banks',
    upstream: '/backend/api/bank/list',
    identity: 'none',
    title: 'Reference: acquirer banks',
  },
];

/**
 * Merge caller input over route defaults, then force the identity fields from the
 * session. Identity is written last specifically so a caller-supplied
 * `merchantCode` or identity block can never take precedence.
 */
export function buildPayload(
  session: SessionPayload,
  incoming: Record<string, unknown>,
  spec: RouteSpec,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...incoming };

  for (const [key, value] of Object.entries(spec.defaults ?? {})) {
    const existing = body[key];
    if (existing === undefined) {
      body[key] = value;
    } else if (
      value &&
      typeof value === 'object' &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      body[key] = { ...value, ...(existing as Record<string, unknown>) };
    }
  }

  const identity: IdentityMode = spec.identity ?? 'full';
  if (identity === 'none') return body;

  if (identity === 'full' && spec.includeMerchantCode !== false) {
    body.merchantCode = session.merchantCode;
  }

  if (identity === 'full') {
    const contextKey = spec.contextKey ?? 'userDetail';
    body[contextKey] = { ...session.userDetail };
  }

  return body;
}
