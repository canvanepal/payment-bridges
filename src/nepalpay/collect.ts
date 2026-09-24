/**
 * Collect — mint a dynamic QR and answer "has it been paid yet?".
 *
 * The portal hands back a `validationTraceId` with every QR and its own
 * transaction records carry the same field, so that id is the primary
 * correlation key. Two fallbacks cover the cases it cannot: the value scan looks
 * for any of our identifiers anywhere in a record (the providers ship
 * undocumented fields), and amount+time catches a record whose id we could not
 * see. Every match reports *which* rule fired, so a surprising result is
 * diagnosable rather than mysterious.
 *
 * NepalPay also exposes a live socket for payment notifications. This bridge does
 * not hold it — Workers are request-scoped and the socket needs a STOMP client —
 * so the material is passed through for callers that want to watch it directly.
 */

import {
  COLLECT_PAID_TTL_SECONDS,
  COLLECT_PENDING_TTL_SECONDS,
  amountsEqual,
  clampTtl,
  newCollectId,
  parseAmount,
  rowCarriesValue,
  rowsFrom,
  withinWindow,
  type CollectOutcome,
  type CollectTicket,
} from '../shared/collect';
import { cacheGet, cachePut, defaultCache } from '../shared/kvcache';
import { parseHeaderMode } from '../shared/headers';
import { callUpstream, normalizeBaseUrl, str } from './client';
import type { Env, SessionPayload } from './types';

export const QR_GENERATE_PATH = '/backend/api/nqr/generate';
export const TRANSACTION_REPORT_PATH = '/backend/api/report/transaction/list';
export const RECENT_TRANSACTIONS_PATH = '/backend/api/dashboard/transaction/list';

/** How far back a status scan looks. Two days covers a QR that stayed open. */
const REPORT_LOOKBACK_DAYS = 2;
/** Rows per report page. One page is enough for a live checkout. */
const REPORT_PAGE_SIZE = 50;

/** Nepal is UTC+5:45, and the portal's own date filters are in local days. */
const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60_000;

function nepalDay(epochMs: number): string {
  return new Date(epochMs + NEPAL_OFFSET_MS).toISOString().slice(0, 10);
}

export type StartCollectOutcome =
  | {
      ok: true;
      ticket: CollectTicket;
      qr: Record<string, unknown>;
      /** The QR itself, as the data URI the portal returns. */
      qrString: string;
    }
  | { ok: false; status: number; code: string; message: string };

export interface Match {
  row: Record<string, unknown>;
  matchedBy: string;
}

/**
 * Decide whether one upstream record is this collect's payment.
 *
 * The amount must agree first: without that, an id echoed into an unrelated row
 * would be enough to report a payment that never happened.
 */
export function matchRow(row: unknown, ticket: CollectTicket, values: string[]): Match | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;

  const amount = Number(record.amount);
  if (Number.isFinite(amount) && !amountsEqual(amount, ticket.amount)) return null;

  const precise: Array<[string, string | undefined]> = [
    ['validationTraceId', ticket.keys.validationTraceId],
    ['nqrTxnId', ticket.keys.nqrTxnId],
    ['merchantTxnRef', ticket.keys.orderId],
    ['instructionId', ticket.keys.orderId],
  ];

  for (const [field, expected] of precise) {
    if (!expected) continue;
    const actual = str(record[field]).trim();
    if (actual && actual.toLowerCase() === expected.toLowerCase()) {
      return { row: record, matchedBy: field };
    }
  }

  if (rowCarriesValue(record, values)) return { row: record, matchedBy: 'value-scan' };

  const stamp = record.localTransactionDateTime ?? record.transactionDate;
  if (Number.isFinite(amount) && withinWindow(stamp, ticket)) {
    return { row: record, matchedBy: 'amount+time' };
  }

  return null;
}

function findMatch(rows: unknown[], ticket: CollectTicket, values: string[]): Match | null {
  for (const row of rows) {
    const match = matchRow(row, ticket, values);
    if (match) return match;
  }
  return null;
}

/** Create a dynamic QR for `amount` and seal a ticket describing the wait. */
export async function startCollect(options: {
  env: Env;
  baseUrl?: string;
  session: SessionPayload;
  input: Record<string, unknown>;
}): Promise<StartCollectOutcome> {
  const amount = parseAmount(options.input.amount);
  if (amount === null) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'amount is required and must be a positive number.',
    };
  }

  const session = options.session;
  const now = Date.now();
  const collectId = newCollectId('NP', now);
  const expiresInSeconds = clampTtl(options.input.expiresInSeconds);

  const storeLabel = str(options.input.storeLabel).trim() || 'Store1';
  const terminal = str(options.input.terminal).trim();
  const orderId = str(options.input.orderId).trim() || collectId;
  // A generated remark keeps the value scan specific when the caller has none.
  const remarks = str(options.input.remarks).trim() || `Bridge collect ${collectId}`;

  let result;
  try {
    result = await callUpstream<Record<string, unknown>>({
      baseUrl: normalizeBaseUrl(options.baseUrl ?? options.env.NEPALPAY_BASE_URL),
      path: QR_GENERATE_PATH,
      method: 'POST',
      body: {
        merchantCode: session.merchantCode,
        storeLabel,
        terminal,
        amount,
        remarks,
        userDetail: { ...session.userDetail },
      },
      accessToken: session.accessToken,
      cookies: session.cookies,
      headerMode: parseHeaderMode(options.env.NEPALPAY_HEADER_MODE),
      debug: options.env.DEBUG_UPSTREAM === '1',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 502, code: 'UPSTREAM_UNREACHABLE', message: `Could not reach NepalPay: ${detail}` };
  }

  if (result.blocked) {
    return { ok: false, status: 502, code: 'UPSTREAM_BLOCKED', message: result.envelope.message };
  }

  if (result.status >= 400 || result.envelope.status !== 'SUCCESS') {
    return {
      ok: false,
      status: 502,
      code: 'QR_FAILED',
      message: result.envelope.message || 'NepalPay refused to generate a dynamic QR.',
    };
  }

  const qr = (result.envelope.data ?? {}) as Record<string, unknown>;
  const validationTraceId = str(qr.validationTraceId).trim();
  if (!validationTraceId) {
    return {
      ok: false,
      status: 502,
      code: 'QR_FAILED',
      message: 'NepalPay returned a QR without a validationTraceId, so the payment could not be tracked.',
    };
  }

  const realtime = str(qr.webSocketUrl).trim()
    ? {
        webSocketUrl: str(qr.webSocketUrl),
        apiToken: str(qr.apiToken),
        username: str(qr.username),
        requestId: validationTraceId,
        channel: '/nqrws/check-txn-status',
        note:
          'Live notification socket, exactly as the portal uses it (STOMP over WebSocket; ' +
          'the token authorises notification traffic only). The bridge confirms payments by ' +
          'polling instead, so you never need this unless you want instant updates.',
      }
    : undefined;

  const ticket: CollectTicket = {
    v: 1,
    provider: 'nepalpay',
    collectId,
    amount,
    remarks,
    orderId,
    keys: {
      validationTraceId,
      orderId,
      remarks,
      ...(str(qr.nqrTxnId).trim() ? { nqrTxnId: str(qr.nqrTxnId).trim() } : {}),
    },
    realtime,
    createdAt: now,
    expiresAt: now + expiresInSeconds * 1000,
  };

  return { ok: true, ticket, qr, qrString: str(qr.qrString) };
}

/** Has this collect been paid? */
export async function collectStatus(options: {
  env: Env;
  baseUrl?: string;
  session: SessionPayload;
  ticket: CollectTicket;
}): Promise<CollectOutcome> {
  const { ticket, session } = options;
  const now = Date.now();

  if (now > ticket.expiresAt) {
    return {
      state: 'EXPIRED',
      note: 'This QR expired and was never paid. Start a new collect.',
    };
  }

  const cache = defaultCache();
  const cacheKey = `collect/nepalpay/${ticket.collectId}`;
  const shared = await cacheGet<CollectOutcome>(cache, cacheKey);
  if (shared) return shared;

  const baseUrl = normalizeBaseUrl(options.baseUrl ?? options.env.NEPALPAY_BASE_URL);
  const headerMode = parseHeaderMode(options.env.NEPALPAY_HEADER_MODE);
  const debug = options.env.DEBUG_UPSTREAM === '1';
  const values = Object.values(ticket.keys).filter(Boolean);

  const report = await callUpstream<Record<string, unknown>>({
    baseUrl,
    path: TRANSACTION_REPORT_PATH,
    method: 'POST',
    body: {
      merchantCode: session.merchantCode,
      fromDate: nepalDay(now - REPORT_LOOKBACK_DAYS * 86_400_000),
      toDate: nepalDay(now),
      storeLabel: '',
      terminal: '',
      nqrTxnId: '',
      payerMobileNumber: '',
      issuerNetwork: '',
      userDetail: { ...session.userDetail },
      pageable: { currentPage: 1, rowPerPage: REPORT_PAGE_SIZE, paginated: true, enable: true },
    },
    accessToken: session.accessToken,
    cookies: session.cookies,
    headerMode,
    debug,
  });

  if (report.blocked || report.status >= 400) {
    return {
      state: 'PENDING',
      upstreamError: report.blocked
        ? report.envelope.message
        : `NepalPay answered the transaction report with HTTP ${report.status}.`,
      note: 'Could not read transactions just now. The QR is still valid; ask again shortly.',
    };
  }

  const found = findMatch(rowsFrom(report.envelope.data), ticket, values);
  if (found) {
    const outcome: CollectOutcome = {
      state: 'PAID',
      transaction: found.row,
      matchedBy: found.matchedBy,
      note: 'Payment received.',
    };
    await cachePut(cache, cacheKey, outcome, COLLECT_PAID_TTL_SECONDS);
    return outcome;
  }

  // The report is a day-scoped aggregate and can lag a fresh payment; the
  // dashboard list is the live one the portal itself refreshes.
  const recent = await callUpstream<unknown>({
    baseUrl,
    path: RECENT_TRANSACTIONS_PATH,
    method: 'POST',
    body: { merchantCode: session.merchantCode },
    accessToken: session.accessToken,
    cookies: session.cookies,
    headerMode,
    debug,
  });

  if (!recent.blocked && recent.status < 400) {
    const hit = findMatch(rowsFrom(recent.envelope.data), ticket, values);
    if (hit) {
      const outcome: CollectOutcome = {
        state: 'PAID',
        transaction: hit.row,
        matchedBy: hit.matchedBy,
        note: 'Payment received.',
      };
      await cachePut(cache, cacheKey, outcome, COLLECT_PAID_TTL_SECONDS);
      return outcome;
    }
  }

  const pending: CollectOutcome = {
    state: 'PENDING',
    note: 'No payment matched this QR yet.',
  };
  await cachePut(cache, cacheKey, pending, COLLECT_PENDING_TTL_SECONDS);
  return pending;
}
