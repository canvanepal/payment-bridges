#!/usr/bin/env node
/**
 * Find the NepalPay token-refresh endpoint inside a captured HAR.
 *
 *   node tools/find-refresh.mjs "path/to/capture.har"
 *
 * Offline and redacting: it never prints passwords or token values, only shapes.
 *
 * How to capture the refresh call:
 *   1. Log in to business.nepalpay.com.np with DevTools > Network open.
 *   2. Leave the tab open past the access token's 1 hour life (or navigate
 *      around until the SPA notices the 401).
 *   3. Right-click the request list > "Save all as HAR", then run this script.
 */
import { readFileSync } from 'node:fs';

const KNOWN_PATHS = new Set([
  '/backend/api/auth/signin',
  '/backend/api/dashboard/images',
  '/backend/api/dashboard/transaction/list',
  '/backend/api/dashboard/transaction/settlement',
  '/backend/api/merchant/stores/list',
  '/backend/api/merchant/stores/terminal/store-label',
  '/backend/api/nqr/generate',
  '/backend/api/report/network/list',
  '/backend/api/report/refund/list',
  '/backend/api/report/settlement/list',
  '/backend/api/report/summary/list',
  '/backend/api/report/transaction/list',
  '/backend/api/stores/create',
  '/backend/api/stores/list',
  '/backend/api/stores/nqr/generate',
  '/backend/api/stores/terminal/store-label',
  '/backend/api/v1/users/list',
]);

const REFRESH_HINT = /refresh|token|reauth|renew|extend|session/i;

/** Render a secret-ish value without leaking it. */
function redact(value) {
  if (typeof value !== 'string') return value;
  if (value.length > 60) return `<${value.length} chars, starts "${value.slice(0, 6)}…">`;
  if (/^eyJ/.test(value)) return `<jwt, ${value.length} chars>`;
  if (/password/i.test(value)) return '<redacted>';
  return value;
}

function redactDeep(value, key = '') {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && /password|token|secret/i.test(key)) return '<redacted>';
    return redact(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, key));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, k)]));
}

const harPath = process.argv[2];
if (!harPath) {
  console.error('usage: node tools/find-refresh.mjs <capture.har>');
  process.exit(1);
}

let har;
try {
  har = JSON.parse(readFileSync(harPath, 'utf8'));
} catch (error) {
  console.error(`Could not read/parse ${harPath}: ${error.message}`);
  process.exit(1);
}

const entries = har.log?.entries ?? [];
console.log(`Loaded ${entries.length} entries from ${harPath}\n`);

function pathOf(entry) {
  try {
    return new URL(entry.request.url).pathname;
  } catch {
    return entry.request.url;
  }
}

function authHeader(entry) {
  const header = (entry.request.headers ?? []).find(
    (h) => h.name.toLowerCase() === 'authorization',
  );
  if (!header) return null;
  const [scheme, value = ''] = header.value.split(' ');
  return `${scheme} <${value.length} chars>`;
}

function bodyOf(entry) {
  const text = entry.request.postData?.text;
  if (!text) return null;
  try {
    return redactDeep(JSON.parse(text));
  } catch {
    return redact(text);
  }
}

/* -------- 1. Candidate refresh calls -------- */

const candidates = entries.filter((entry) => {
  if (REFRESH_HINT.test(pathOf(entry))) return true;
  // Or: any non-signin request that came back carrying a fresh access token.
  const body = entry.response.content?.text ?? '';
  return /"(accessToken|access_token|refreshToken|refresh_token)"\s*:/.test(body);
});

console.log('=== 1. Candidate refresh calls ===');
if (candidates.length === 0) {
  console.log('   None found in this capture.');
  console.log('   The SPA had not needed to refresh yet. Capture again after the');
  console.log('   access token expires (~1 hour) and re-run.');
} else {
  for (const entry of candidates) {
    const responseText = entry.response.content?.text ?? '';
    let responseKeys = '(non-JSON)';
    try {
      const parsed = JSON.parse(responseText);
      responseKeys = Object.keys(parsed.data ?? parsed).join(', ') || '(no keys)';
    } catch {
      /* leave default */
    }

    console.log(`\n   ${entry.request.method} ${pathOf(entry)}`);
    console.log(`     status        : ${entry.response.status}`);
    console.log(`     authorization : ${authHeader(entry) ?? '(none)'}`);
    console.log(`     content-type  : ${entry.request.postData?.mimeType ?? '(no body)'}`);
    console.log(`     request body  : ${JSON.stringify(bodyOf(entry))}`);
    console.log(`     response keys : ${responseKeys}`);
  }
}

/* -------- 2. Endpoints not yet wired into the Worker -------- */

const unseen = [...new Set(entries.map(pathOf).filter((path) => !KNOWN_PATHS.has(path)))].filter(
  (path) => path.startsWith('/backend/'),
);

console.log('\n=== 2. Backend endpoints not yet in src/routes.ts ===');
console.log(unseen.length ? unseen.map((p) => `   ${p}`).join('\n') : '   (none)');

/* -------- 3. Auth-token shape changes -------- */

const issuers = entries.filter((entry) =>
  /"(refreshToken|refresh_token)"\s*:/.test(entry.response.content?.text ?? ''),
);

console.log('\n=== 3. Responses that issued a refresh token ===');
console.log(
  issuers.length
    ? issuers.map((e) => `   ${e.request.method} ${pathOf(e)} -> ${e.response.status}`).join('\n')
    : '   (none)',
);

console.log('\nNext step: if section 1 found a path, set it as NEPALPAY_REFRESH_PATH');
console.log('and the presentation style as NEPALPAY_REFRESH_STYLE, then run');
console.log('POST /api/auth/refresh to confirm.');
