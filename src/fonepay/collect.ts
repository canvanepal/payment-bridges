/**
 * Collect — mint a Fonepay dynamic QR and answer "has it been paid yet?".
 *
 * Fonepay's collection report does not carry an order id, so the searchable key
 * is the `remarks` text on the QR. The bridge therefore always writes a unique
 * remark (`Bridge collect <id>`) when the caller does not supply one — two
 * identical amounts in the same window would otherwise be impossible to tell
 * apart. Order id, reference id and websocket id are searched too, along with a
 * value scan for any identifier appearing anywhere in a record.
 *
 * As with NepalPay, the live socket is handed to the caller rather than held: a
 * Worker is request-scoped, and the portal itself drives that socket from the
 * browser. Confirmation here is by polling, which needs no socket at all.
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
import { apiOrigin, callUpstream, defaultMerchantId, payloadOf, str } from './client';
import { buildFonepayRequest, QR_DYNAMIC_SPEC, ScopeError, TRANSACTIONS_SPEC } from './routes';
import type { Env, FonepaySession } from './types';

/** Rows read per status scan. One page covers a live checkout comfortably. */
const SCAN_PAGE_SIZE = 100;
/** How far back a scan looks, in days. */
const SCAN_LOOKBACK_DAYS = 1;

/** A payment row is only a candidate when the gateway itself called it a success. */
const SUCCESS_PATTERN = /success|completed|settled|approved/i;

function day(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export type StartCollectOutcome =
  | {
      ok: true;
      ticket: CollectTicket;
      qr: Record<string, unknown>;
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
 * The amount must agree first, and the gateway must itself call the row a
 * success, before any identifier is trusted.
 */
export function matchRow(row: unknown, ticket: CollectTicket, values: string[]): Match | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;

  const amount = Number(record.amount);
  if (Number.isFinite(amount) && !amountsEqual(amount, ticket.amount)) return null;

  const status = str(record.paymentStatus, str(record.status)).trim();
  if (status && !SUCCESS_PATTERN.test(status)) return null;

  const precise: Array<[string, string | undefined]> = [
    ['remarks', ticket.keys.remarks],
    ['remarks1', ticket.keys.remarks],
    ['orderId', ticket.keys.orderId],
    // The gateway may echo our order id back as the reference id.
    ['referenceId', ticket.keys.referenceId ?? ticket.keys.orderId],
  ];

  for (const [field, expected] of precise) {
    if (!expected) continue;
    const actual = str(record[field]).trim();
    if (actual && actual.toLowerCase() === expected.toLowerCase()) {
      return { row: record, matchedBy: field };
    }
  }

  if (rowCarriesValue(record, values)) return { row: record, matchedBy: 'value-scan' };

  const stamp = record.transactionDate ?? record.localTransactionDate;
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

/** How long a resolved sub-merchant/terminal pair is reused per merchant. */
const QR_TARGET_TTL_SECONDS = 600;

/**
 * The sub-merchant and terminal a QR must name, resolved the way the portal
 * resolves them: from `linked-merchants/{id}/hierarchy`, preferring each
 * `isDefault` entry and an ACTIVE terminal. The gateway rejects a QR without
 * `SubMerchantId`, and these ids exist nowhere else, so callers that omit them
 * get the defaults. A failed lookup resolves to nothing — the caller's body is
 * left as built and the gateway's own validation error passes through.
 */
export async function resolveQrTargets(
  env: Env,
  session: FonepaySession,
  merchantId: string,
  hintSub?: unknown,
): Promise<{ subMerchantId?: number | string; terminalId?: number | string }> {
  if (!merchantId) return {};

  const cache = defaultCache();
  const cacheKey = `qrtarget/${merchantId}`;
  type Hierarchy = { subMerchants?: Array<Record<string, unknown>> };
  let data: Hierarchy | null = cache ? await cacheGet<Hierarchy>(cache, cacheKey) : null;

  if (!data) {
    const result = await callUpstream({
      baseUrl: apiOrigin(env),
      path: `/corporate/api/v1/merchant-collection/linked-merchants/${merchantId}/hierarchy`,
      method: 'GET',
      accessToken: session.accessToken,
      env,
    });
    if (!result.ok) return {};
    data = payloadOf(result.body) as Hierarchy;
    if (cache) await cachePut(cache, cacheKey, data, QR_TARGET_TTL_SECONDS);
  }

  const subs = Array.isArray(data.subMerchants) ? data.subMerchants : [];
  if (subs.length === 0) return {};

  const hint = str(hintSub);
  const sub =
    (hint ? subs.find((candidate) => str(candidate.id) === hint) : undefined) ??
    subs.find((candidate) => candidate.isDefault === true) ??
    subs[0];

  const terminals = Array.isArray(sub?.terminals)
    ? (sub.terminals as Array<Record<string, unknown>>)
    : [];
  const terminal =
    terminals.find((t) => t.isDefault === true && t.status === 'ACTIVE') ??
    terminals.find((t) => t.status === 'ACTIVE') ??
    terminals[0];

  const targets: { subMerchantId?: number | string; terminalId?: number | string } = {};
  if (sub?.id !== undefined && sub?.id !== null) targets.subMerchantId = sub.id as number | string;
  if (terminal?.id !== undefined && terminal?.id !== null) {
    targets.terminalId = terminal.id as number | string;
  }
  return targets;
}

/** Mint a dynamic QR for `amount` and seal a ticket describing the wait. */
export async function startCollect(options: {
  env: Env;
  session: FonepaySession;
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
  const collectId = newCollectId('FP', now);
  const expiresInSeconds = clampTtl(options.input.expiresInSeconds);
  const orderId = str(options.input.orderId).trim() || collectId;
  const remarks = str(options.input.remarks).trim() || `Bridge collect ${collectId}`;

  let request;
  try {
    request = buildFonepayRequest(session, QR_DYNAMIC_SPEC, {
      ...options.input,
      amount,
      orderId,
      remarks,
    });
  } catch (error) {
    if (error instanceof ScopeError) {
      return { ok: false, status: 400, code: 'INVALID_REQUEST', message: error.message };
    }
    throw error;
  }

  // The gateway requires a sub-merchant and terminal on every dynamic QR.
  if (request.body && (!str(request.body.subMerchantId) || !str(request.body.terminalId))) {
    const targets = await resolveQrTargets(
      options.env,
      session,
      str(options.input.merchantId) || defaultMerchantId(session),
      request.body.subMerchantId,
    );
    if (targets.subMerchantId !== undefined && !str(request.body.subMerchantId)) {
      request.body.subMerchantId = targets.subMerchantId;
    }
    if (targets.terminalId !== undefined && !str(request.body.terminalId)) {
      request.body.terminalId = targets.terminalId;
    }
  }

  const result = await callUpstream({
    baseUrl: apiOrigin(options.env),
    path: `${request.path}${request.query}`,
    method: QR_DYNAMIC_SPEC.method,
    body: request.body,
    accessToken: session.accessToken,
    env: options.env,
  });

  if (!result.ok || result.status >= 400) {
    return {
      ok: false,
      status: result.status >= 400 ? result.status : 502,
      code: result.status === 401 ? 'SESSION_EXPIRED' : 'QR_FAILED',
      message: result.status === 401
        ? 'Fonepay rejected the session. Sign in again.'
        : `Fonepay refused to generate a dynamic QR: ${result.message}`,
    };
  }

  // The payload sits under `data`, like every other gateway endpoint.
  const qr = payloadOf(result.body);
  const qrString = str(qr.qrString, str(qr.qrMessage));

  if (!qrString) {
    return {
      ok: false,
      status: 502,
      code: 'QR_FAILED',
      message: 'Fonepay returned a QR response without a qrMessage, so there is nothing to display.',
    };
  }

  const upstreamExpiry = Date.parse(str(qr.expiresAt));
  const expiresAt = Number.isFinite(upstreamExpiry)
    ? Math.min(now + expiresInSeconds * 1000, upstreamExpiry)
    : now + expiresInSeconds * 1000;

  const websocketId = str(qr.websocketId).trim();
  // The merchant id the QR was actually minted under, so the status scan reads
  // the same merchant's report rather than the session default.
  const resolvedMerchantId = str(request.body?.merchantId).trim();

  const ticket: CollectTicket = {
    v: 1,
    provider: 'fonepay',
    collectId,
    amount,
    remarks,
    orderId,
    keys: {
      remarks,
      orderId,
      ...(resolvedMerchantId ? { merchantId: resolvedMerchantId } : {}),
      ...(str(qr.referenceId).trim() ? { referenceId: str(qr.referenceId).trim() } : {}),
      ...(websocketId ? { websocketId } : {}),
    },
    realtime: websocketId
      ? {
          requestId: websocketId,
          note:
            'Fonepay hands back a websocket id for live payment notifications. The bridge ' +
            'confirms payments by polling the collection report instead, so this is only ' +
            'useful if you have the portal open alongside.',
        }
      : undefined,
    createdAt: now,
    expiresAt,
  };

  return { ok: true, ticket, qr, qrString };
}

/** Has this collect been paid? */
export async function collectStatus(options: {
  env: Env;
  session: FonepaySession;
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
  const cacheKey = `collect/fonepay/${ticket.collectId}`;
  const shared = await cacheGet<CollectOutcome>(cache, cacheKey);
  if (shared) return shared;

  const values = Object.values(ticket.keys).filter(Boolean);

  let request;
  try {
    request = buildFonepayRequest(session, TRANSACTIONS_SPEC, {
      page: 0,
      size: SCAN_PAGE_SIZE,
      fromTransmissionDateTime: day(ticket.createdAt - SCAN_LOOKBACK_DAYS * 86_400_000),
      toTransmissionDateTime: day(now),
      ...(str(ticket.keys.merchantId) ? { merchantId: ticket.keys.merchantId } : {}),
    });
  } catch (error) {
    if (error instanceof ScopeError) {
      return {
        state: 'PENDING',
        upstreamError: error.message,
        note: 'Could not scan transactions for this collect.',
      };
    }
    throw error;
  }

  const result = await callUpstream({
    baseUrl: apiOrigin(options.env),
    path: `${request.path}${request.query}`,
    method: TRANSACTIONS_SPEC.method,
    body: request.body,
    accessToken: session.accessToken,
    env: options.env,
  });

  if (!result.ok || result.status >= 400) {
    return {
      state: 'PENDING',
      upstreamError: result.message || `Fonepay answered HTTP ${result.status}.`,
      note: 'Could not read the collection report just now. The QR is still valid; ask again shortly.',
    };
  }

  const found = findMatch(rowsFrom(result.body), ticket, values);
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

  const pending: CollectOutcome = {
    state: 'PENDING',
    note: 'No payment matched this QR yet.',
  };
  await cachePut(cache, cacheKey, pending, COLLECT_PENDING_TTL_SECONDS);
  return pending;
}
