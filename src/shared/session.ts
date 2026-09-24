/**
 * Sealed-token crypto, shared by every provider bridge.
 *
 * A payload is encrypted into one opaque, tamper-evident token with AES-GCM,
 * keyed by the Worker's `SESSION_SECRET`. Nothing is stored server-side, so there
 * is no KV eventual-consistency window and no session database to operate.
 *
 * Two kinds of payload travel through here: provider *sessions*, which carry an
 * upstream access token, and *collect tickets*, which describe a payment that is
 * being waited on. Both need the same seal/unseal guarantees, so the crypto is
 * generic and the version tag is the only shared requirement.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const IV_LENGTH = 12;
const KEY_LENGTH = 32;

/** Minimum shape of anything that gets sealed. */
export interface SealedToken {
  v: 1;
}

/** Minimum shape every provider's session must satisfy. */
export interface SealedSession extends SealedToken {
  /** Upstream access token, replayed as `Authorization: Bearer …`. */
  accessToken: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  const raw = base64UrlDecode(secret.trim());
  if (raw.byteLength !== KEY_LENGTH) {
    throw new Error(
      `SESSION_SECRET must decode to exactly ${KEY_LENGTH} bytes (got ${raw.byteLength}).`,
    );
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt any versioned payload into an opaque token the client can hold. */
export async function sealToken<T extends SealedToken>(payload: T, secret: string): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload))),
  );

  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);

  return base64UrlEncode(combined);
}

/**
 * Decrypt a token, returning null when it is malformed, fails authentication, or
 * does not satisfy the caller's `isValid` check.
 */
export async function openToken<T extends SealedToken>(
  token: string,
  secret: string,
  isValid?: (payload: T) => boolean,
): Promise<T | null> {
  try {
    const key = await importKey(secret);
    const raw = base64UrlDecode(token);
    if (raw.byteLength <= IV_LENGTH) return null;

    const iv = raw.slice(0, IV_LENGTH);
    const ciphertext = raw.slice(IV_LENGTH);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

    const parsed = JSON.parse(decoder.decode(plaintext)) as T;
    if (parsed?.v !== 1) return null;
    if (isValid && !isValid(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Encrypt a session into an opaque token the client can hold. */
export function sealSession<T extends SealedSession>(session: T, secret: string): Promise<string> {
  return sealToken(session, secret);
}

/** Decrypt a session token, returning null when it is malformed or tampered with. */
export function openSession<T extends SealedSession>(
  token: string,
  secret: string,
): Promise<T | null> {
  return openToken<T>(token, secret, (payload) => typeof payload.accessToken === 'string');
}
