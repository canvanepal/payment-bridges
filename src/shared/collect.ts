/**
 * Collect tickets — the shared half of "take a payment and tell me when it lands".
 *
 * A collect is two calls:
 *
 *   POST /api/collect        mint a dynamic QR, return a *ticket* that describes
 *                            what we are waiting for
 *   GET  /api/collect/:id    ask whether that payment has arrived
 *
 * The ticket is a sealed token rather than server state, matching how sessions
 * work: no storage to run, and the caller cannot edit what it is waiting for. It
 * holds the correlation values the provider's own reporting exposes, so the
 * status call can recognise the payment without guessing.
 */

import { openToken, sealToken, type SealedToken } from './session';

/** Default lifetime of a collect ticket. */
export const COLLECT_DEFAULT_TTL_SECONDS = 600;
export const COLLECT_MIN_TTL_SECONDS = 60;
export const COLLECT_MAX_TTL_SECONDS = 900;

/** How long a PENDING verdict is shared, so watchers do not each poll upstream. */
export const COLLECT_PENDING_TTL_SECONDS = 3;
/** How long a PAID verdict is shared. A settled payment never un-settles. */
export const COLLECT_PAID_TTL_SECONDS = 300;

/** Suggested delay before asking again, returned with every PENDING verdict. */
export const COLLECT_RETRY_AFTER_MS = 2500;

/** Two amounts are the same payment if they agree to a paisa. */
const AMOUNT_EPSILON = 0.011;

/**
 * Live-status material some providers hand back with a QR.
 *
 * NepalPay returns a websocket URL plus a short-lived token scoped to QR
 * notifications, and its own portal drives a STOMP client from the browser with
 * exactly these values. The bridge cannot hold that socket for you, so it is
 * passed through for callers that want to watch it directly — with the caveat in
 * `note` that it authorises *notification* traffic, not the merchant API.
 */
export interface RealtimeHint {
  webSocketUrl?: string;
  apiToken?: string;
  username?: string;
  requestId?: string;
  channel?: string;
  note: string;
}

/** What a status call is waiting for, sealed into the collect id. */
export interface CollectTicket extends SealedToken {
  v: 1;
  provider: 'nepalpay' | 'fonepay';
  /** Human-readable id, echoed in every response for logging. */
  collectId: string;
  /** Expected amount, exactly as sent upstream. */
  amount: number;
  /** Free text the caller wanted attached, and which is also a correlation key. */
  remarks: string;
  /** Order reference, either the caller's or one the bridge generated. */
  orderId: string;
  /**
   * Provider-specific correlation values, e.g. NepalPay's `validationTraceId`.
   * Every value here is searched for in the provider's own records.
   */
  keys: Record<string, string>;
  realtime?: RealtimeHint;
  createdAt: number;
  expiresAt: number;
}

export type CollectState = 'PENDING' | 'PAID' | 'EXPIRED';

export interface CollectOutcome<T = unknown> {
  state: CollectState;
  /** The matched record, when the provider returned one. */
  transaction?: T;
  /** Which correlation key recognised the payment — useful when debugging. */
  matchedBy?: string;
  /** Human-readable explanation, always safe to show. */
  note?: string;
  /**
   * Set when the status could not be determined because upstream misbehaved.
   * The state stays PENDING — the QR is still valid — but a caller that logs
   * this can tell "not yet" apart from "we could not look".
   */
  upstreamError?: string;
}

const randomSuffix = (): string =>
  [...crypto.getRandomValues(new Uint8Array(3))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

/** Readable, sortable, collision-resistant collect id, e.g. `NP-20260924-7F2A91`. */
export function newCollectId(prefix: string, now = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${day}-${randomSuffix()}`;
}

/** Clamp a caller-supplied ticket lifetime into the supported range. */
export function clampTtl(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return COLLECT_DEFAULT_TTL_SECONDS;
  return Math.min(COLLECT_MAX_TTL_SECONDS, Math.max(COLLECT_MIN_TTL_SECONDS, Math.round(seconds)));
}

export function sealTicket(ticket: CollectTicket, secret: string): Promise<string> {
  return sealToken(ticket, secret);
}

/** Unseal a collect token, rejecting anything that is not a well-formed ticket. */
export function openTicket(token: string, secret: string): Promise<CollectTicket | null> {
  return openToken<CollectTicket>(token, secret, (payload) => {
    if (typeof payload.collectId !== 'string' || !payload.collectId) return false;
    if (typeof payload.amount !== 'number' || !Number.isFinite(payload.amount)) return false;
    return Boolean(payload.keys && typeof payload.keys === 'object');
  });
}

/** Parse an amount from caller input. Returns null when it is not usable money. */
export function parseAmount(value: unknown): number | null {
  const amount = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100) / 100;
}

export function amountsEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < AMOUNT_EPSILON;
}

/**
 * Does this record carry any of our correlation values?
 *
 * Deliberately generic: the providers disagree on field names, and both have
 * shipped fields that are undocumented. Rather than guess a name, look for the
 * *value* anywhere in the record. Scalars are compared case-insensitively, and
 * nesting is walked a few levels so a value inside `data` or an array is seen.
 */
export function rowCarriesValue(row: unknown, values: string[], depth = 0): boolean {
  if (row === null || row === undefined) return false;
  if (depth > 4) return false;

  if (typeof row === 'string') {
    const needle = row.trim().toLowerCase();
    return needle.length > 0 && values.some((value) => value.toLowerCase() === needle);
  }

  if (typeof row === 'number' || typeof row === 'boolean') {
    return values.some((value) => String(row) === value);
  }

  if (Array.isArray(row)) return row.some((entry) => rowCarriesValue(entry, values, depth + 1));

  if (typeof row === 'object') {
    return Object.values(row as Record<string, unknown>).some((value) =>
      rowCarriesValue(value, values, depth + 1),
    );
  }

  return false;
}

/** Pull the list of records out of whichever envelope a provider used. */
export function rowsFrom(
  value: unknown,
  keys = ['result', 'content', 'list', 'data', 'items', 'records'],
): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate;
      if (candidate && typeof candidate === 'object') {
        const nested = rowsFrom(candidate, keys);
        if (nested.length > 0) return nested;
      }
    }
  }

  return [];
}

/** Nepal's fixed offset. The country has never observed DST, so this is exact. */
const NEPAL_OFFSET = '+05:45';

/** Wall-clock shape both portals emit, with no timezone designator. */
const LOCAL_STAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

/**
 * Parse a timestamp from a portal record.
 *
 * Both portals report *Nepal-local* wall-clock strings like `2026-09-24 10:05:00`
 * with no offset. Read literally on a Worker (which runs in UTC) such a value
 * looks almost six hours older than it is, which is enough for a genuine payment
 * to fall outside the matching window. So a bare local string is pinned to
 * +05:45 rather than handed to the platform's zone guesswork.
 */
function parseStamp(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const text = value.trim();
  if (!text) return Number.NaN;
  if (LOCAL_STAMP.test(text)) return Date.parse(`${text.replace(' ', 'T')}${NEPAL_OFFSET}`);
  return Date.parse(text);
}

/**
 * A record is only considered if it is recent enough to be *this* payment.
 * Prevents a poll from matching a genuinely identical amount paid yesterday.
 */
export function withinWindow(
  timestamp: unknown,
  ticket: Pick<CollectTicket, 'createdAt'>,
  slackMs = 30 * 60_000,
): boolean {
  const at = parseStamp(timestamp);
  if (!Number.isFinite(at)) return false;
  return at >= ticket.createdAt - slackMs;
}
