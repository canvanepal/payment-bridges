import { defaultMerchantId, merchantIsAllowed } from './client';
import type { FonepaySession } from './types';

/**
 * A route on the bridge, mapped to one corporate-gateway call.
 *
 * The gateway splits its surface across two prefixes — most merchant-collection
 * endpoints sit under `/corporate/api/v1/...`, while the older transaction
 * helpers sit under `/corporate/api/api/v1/...`. Upstream paths are therefore
 * written in full rather than assembled from a base plus a suffix.
 */
export interface FonepayRouteSpec {
  /** Bridge path, appended to `/api`. May contain `:name` segments. */
  path: string;
  /** Upstream path with `{name}` placeholders. */
  upstream: string;
  method: 'GET' | 'POST';
  title: string;
  /**
   * Names taken from the caller and placed in the path (when a matching
   * placeholder exists) or appended as query parameters. `merchantId` is filled
   * from the session when the caller omits it.
   */
  params?: string[];
  /** Names copied from the caller into the JSON body. */
  bodyKeys?: string[];
  defaults?: {
    query?: Record<string, string | number>;
    body?: Record<string, unknown>;
  };
  /** `merchant` verifies any `merchantId` against the session's linked merchants. */
  scope?: 'merchant' | 'none';
  /**
   * When set, a successful response is reused for this many seconds instead of
   * re-calling the gateway. Keyed by account scope plus the built request, so
   * callers of one corporate account share the answer and no other account can
   * see it. For reference data only — never for anything that changes minute to
   * minute.
   */
  cacheSeconds?: number;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The dynamic-QR route. Named so the collect flow reuses the exact same spec the
 * route table exposes, instead of duplicating an upstream path that could drift.
 */
export const QR_DYNAMIC_SPEC: FonepayRouteSpec = {
  path: '/qr/dynamic',
  upstream: '/corporate/api/v1/merchant-collection/linked-merchants/{merchantId}/qr/dynamic',
  method: 'POST',
  title: 'Dynamic QR for an amount — returns qrMessage plus a websocket URL',
  params: ['merchantId'],
  bodyKeys: ['amount', 'remarks', 'orderId', 'subMerchantId', 'terminalId'],
  defaults: { body: { amount: 1, remarks: 'Test payment', orderId: 'INV-1' } },
};

/** The filtered-collection-report route, reused by the collect status scan. */
export const TRANSACTIONS_SPEC: FonepayRouteSpec = {
  path: '/transactions',
  upstream: '/corporate/api/v1/merchant-collection/collections/transactions/filtered',
  method: 'POST',
  title: 'Collection transactions for a date range',
  params: ['page', 'size', 'fromTransmissionDateTime', 'toTransmissionDateTime'],
  defaults: {
    query: {
      page: 0,
      size: 25,
      fromTransmissionDateTime: today(),
      toTransmissionDateTime: today(),
    },
    body: { merchantId: '', subMerchantId: '', terminalId: '' },
  },
  bodyKeys: ['merchantId', 'subMerchantId', 'terminalId'],
};

/**
 * The curated surface. Paths, query keys, bodies and success codes were read out
 * of the portal's own bundle and its captured traffic — see docs/fonepay-bridge.md.
 *
 * Every route needs an access token; merchant-scoped routes additionally resolve
 * a `merchantId`, which defaults to the session's first linked merchant.
 */
export const FONEPAY_ROUTES: FonepayRouteSpec[] = [
  /* --- merchants ------------------------------------------------------- */
  {
    path: '/merchants',
    upstream: '/corporate/api/v1/merchant-collection/linked-merchants',
    method: 'GET',
    title: 'Linked merchants this account can collect for',
    scope: 'none',
  },
  {
    path: '/merchants/access',
    upstream: '/corporate/api/v1/merchant-collection/access/my-merchants',
    method: 'GET',
    title: 'Merchants this account has been granted access to',
    scope: 'none',
  },
  {
    path: '/merchants/pending-count',
    upstream: '/corporate/api/v1/merchant-collection/access/pending-count',
    method: 'GET',
    title: 'Counts of pending access requests and approvals',
    scope: 'none',
  },
  {
    path: '/merchants/hierarchy',
    upstream: '/corporate/api/v1/merchant-collection/linked-merchants/{merchantId}/hierarchy',
    method: 'GET',
    title: 'Sub-merchants and terminals under a linked merchant',
    params: ['merchantId'],
  },
  {
    path: '/merchants/access-list',
    upstream: '/corporate/api/v1/merchant-collection/access/merchant/{merchantId}',
    method: 'POST',
    title: 'Users granted access to a linked merchant',
    params: ['merchantId'],
    bodyKeys: ['pageNumber', 'pageSize'],
    defaults: { body: { pageNumber: 1, pageSize: 10 } },
  },

  /* --- collections ----------------------------------------------------- */
  TRANSACTIONS_SPEC,
  {
    path: '/transactions/summary',
    upstream: '/corporate/api/v1/merchant-collection/collections/transactions/summary',
    method: 'POST',
    title: 'Totals for a date range — the dashboard figure',
    params: ['fromTransmissionDateTime', 'toTransmissionDateTime'],
    defaults: {
      query: { fromTransmissionDateTime: today(), toTransmissionDateTime: today() },
      body: { merchantId: '' },
    },
    bodyKeys: ['merchantId'],
  },
  {
    path: '/transactions/hierarchy',
    upstream: '/corporate/api/v1/merchant-collection/collections/transactions/my-hierarchy',
    method: 'GET',
    title: 'The filter tree the portal uses on the transactions screen',
    scope: 'none',
    cacheSeconds: 900,
  },
  {
    path: '/transactions/detail',
    upstream: '/corporate/api/v1/merchant-collection/collections/transactions/{transactionId}',
    method: 'GET',
    title: 'One transaction by its id',
    params: ['transactionId'],
    scope: 'none',
  },
  {
    path: '/transactions/pending',
    upstream: '/corporate/api/api/v1/transaction/transaction-pending-approval-list',
    method: 'POST',
    title: 'Transactions awaiting approval',
    bodyKeys: ['pageNumber', 'pageSize'],
    defaults: { body: { pageNumber: 1, pageSize: 10 } },
    scope: 'none',
  },

  /* --- settlements ----------------------------------------------------- */
  {
    path: '/settlements',
    upstream: '/corporate/api/v1/merchant-collection/settlements',
    method: 'POST',
    title: 'Settlement report for a date range',
    params: ['pageNumber', 'pageSize', 'fromSettlementDate', 'toSettlementDate'],
    defaults: {
      query: {
        pageNumber: 1,
        pageSize: 25,
        fromSettlementDate: today(),
        toSettlementDate: today(),
      },
      body: { merchantId: '', id: null, type: null, settlementType: null },
    },
    bodyKeys: ['merchantId', 'id', 'type', 'settlementType'],
  },

  /* --- QR -------------------------------------------------------------- */
  {
    path: '/qr/static',
    upstream: '/corporate/api/v1/merchant-collection/linked-merchants/{merchantId}/qr/generate',
    method: 'POST',
    title: 'Static Fonepay QR for a terminal',
    params: ['merchantId', 'subMerchantId', 'terminalId'],
    defaults: { query: { subMerchantId: '', terminalId: '' } },
  },
  QR_DYNAMIC_SPEC,

  /* --- profile, users and reports -------------------------------------- */
  {
    path: '/profile',
    upstream: '/corporate/api/profile/fetch-user-profile-details',
    method: 'GET',
    title: 'Signed-in user profile',
    scope: 'none',
  },
  {
    path: '/users',
    upstream: '/corporate/api/user/active-corporate-user-list',
    method: 'POST',
    title: 'Active users on the corporate account',
    defaults: { body: {} },
    scope: 'none',
  },
  {
    path: '/reports/transactions',
    upstream: '/corporate/api/api/v1/transaction/report-list',
    method: 'POST',
    title: 'Transaction report list',
    bodyKeys: ['pageNumber', 'pageSize'],
    defaults: { body: { pageNumber: 1, pageSize: 10 } },
    scope: 'none',
  },
];

export class ScopeError extends Error {}

export interface BuiltRequest {
  path: string;
  query: string;
  body?: Record<string, unknown>;
}

/**
 * Resolve a route spec into a concrete upstream request.
 *
 * The caller supplies business inputs only. `merchantId` is taken from the
 * session's linked merchants unless the caller names one, and any named merchant
 * is checked against that list — so a caller cannot widen scope to a merchant
 * the signed-in account was never linked to.
 */
export function buildFonepayRequest(
  session: FonepaySession,
  spec: FonepayRouteSpec,
  incoming: Record<string, unknown>,
): BuiltRequest {
  const query: Record<string, string> = {};
  const queryDefaults = spec.defaults?.query ?? {};

  for (const key of Object.keys(queryDefaults)) {
    const value = queryDefaults[key];
    query[key] = value === undefined || value === null ? '' : String(value);
  }

  let merchantId = '';
  if (spec.params?.includes('merchantId') || spec.bodyKeys?.includes('merchantId')) {
    merchantId = incoming.merchantId === undefined || incoming.merchantId === null || incoming.merchantId === ''
      ? defaultMerchantId(session)
      : String(incoming.merchantId);

    if (merchantId && !merchantIsAllowed(session, merchantId)) {
      throw new ScopeError(
        `Merchant ${merchantId} is not linked to this account. Sign in again if the link is new.`,
      );
    }
  }

  let path = spec.upstream;
  const used = new Set<string>();

  for (const name of spec.params ?? []) {
    const value =
      name === 'merchantId'
        ? merchantId
        : incoming[name] !== undefined && incoming[name] !== null && incoming[name] !== ''
          ? String(incoming[name])
          : (query[name] ?? '');

    if (path.includes(`{${name}}`)) {
      used.add(name);
      if (!value) {
        throw new ScopeError(
          `Missing required parameter "${name}" for ${spec.method} /api${spec.path}.`,
        );
      }
      path = path.split(`{${name}}`).join(encodeURIComponent(value));
    } else if (value !== '') {
      // Anything the caller actually sent wins over the route default.
      if (incoming[name] !== undefined && incoming[name] !== null && incoming[name] !== '') {
        query[name] = String(incoming[name]);
      }
    }
  }

  const body: Record<string, unknown> = { ...(spec.defaults?.body ?? {}) };
  for (const key of spec.bodyKeys ?? []) {
    if (key === 'merchantId') {
      if (merchantId) body.merchantId = merchantId;
      continue;
    }
    const value = incoming[key];
    if (value === undefined || value === null || value === '') continue;
    body[key] = value;
  }

  const queryString = Object.keys(query)
    .filter((key) => query[key] !== '')
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
    .join('&');

  const hasBody = spec.method === 'POST';
  return {
    path,
    query: queryString ? `?${queryString}` : '',
    body: hasBody ? body : undefined,
  };
}
