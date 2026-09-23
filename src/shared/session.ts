/**
 * Sealed-session crypto, shared by every provider bridge.
 *
 * A session is encrypted into one opaque, tamper-evident token with AES-GCM,
 * keyed by the Worker's `SESSION_SECRET`. Nothing is stored server-side, so there
 * is no KV eventual-consistency window and no session database to operate.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const IV_LENGTH = 12;
const KEY_LENGTH = 32;

/** Minimum shape every provider's session must satisfy. */
export interface SealedSession {
  v: 1;
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

/** Encrypt a session into an opaque token the client can hold. */
export async function sealSession<T extends SealedSession>(
  session: T,
  secret: string,
): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(session))),
  );

  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);

  return base64UrlEncode(combined);
}

/** Decrypt a session token, returning null when it is malformed or fails authentication. */
export async function openSession<T extends SealedSession>(
  token: string,
  secret: string,
): Promise<T | null> {
  try {
    const key = await importKey(secret);
    const raw = base64UrlDecode(token);
    if (raw.byteLength <= IV_LENGTH) return null;

    const iv = raw.slice(0, IV_LENGTH);
    const ciphertext = raw.slice(IV_LENGTH);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

    const parsed = JSON.parse(decoder.decode(plaintext)) as T;
    return parsed?.v === 1 && typeof parsed.accessToken === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
