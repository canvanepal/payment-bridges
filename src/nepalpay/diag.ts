import { normalizeBaseUrl } from './client';
import { HEADER_MODES, parseHeaderMode, upstreamHeaders, type HeaderMode } from '../shared/headers';

/**
 * Runs a fixed, credential-free matrix of header profiles against the portal's
 * sign-in endpoint with an empty body. A working profile gets the API's own JSON
 * envelope (`400 Invalid Request Parameters`); a filtered profile gets the edge's
 * HTML rejection page or a 52x.
 *
 * The target is hardcoded and the body is always `{}`, so this cannot be used to
 * reach anything else. It still needs `DIAG_TOKEN` set, and stays 404 otherwise.
 */
const PROBE_PATH = '/backend/api/auth/signin';
const PROBE_TIMEOUT_MS = 12_000;

interface ProbeResult {
  mode: HeaderMode;
  status: number;
  contentType: string;
  elapsedMs: number;
  verdict: 'API_REACHED' | 'BLOCKED' | 'ERROR';
  snippet: string;
}

function classify(status: number, contentType: string, body: string): ProbeResult['verdict'] {
  if (/application\/json/i.test(contentType) && body.trimStart().startsWith('{')) return 'API_REACHED';
  if (/text\/html/i.test(contentType)) return 'BLOCKED';
  if (/\berror code: 52[0-7]\b/i.test(body)) return 'BLOCKED';
  return status > 0 ? 'ERROR' : 'ERROR';
}

async function probe(baseUrl: string, mode: HeaderMode): Promise<ProbeResult> {
  const origin = new URL(baseUrl).origin;
  const headers = upstreamHeaders({ mode, origin, hasBody: true });
  const started = Date.now();

  try {
    const response = await fetch(`${baseUrl}${PROBE_PATH}`, {
      method: 'POST',
      headers,
      body: '{}',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    return {
      mode,
      status: response.status,
      contentType,
      elapsedMs: Date.now() - started,
      verdict: classify(response.status, contentType, body),
      snippet: body.replace(/\s+/g, ' ').slice(0, 180),
    };
  } catch (error) {
    return {
      mode,
      status: 0,
      contentType: '',
      elapsedMs: Date.now() - started,
      verdict: 'ERROR',
      snippet: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runProbeMatrix(
  baseUrl: string,
  env: { NEPALPAY_HEADER_MODE?: string },
): Promise<{ results: ProbeResult[]; configured: HeaderMode; working: HeaderMode[] }> {
  const results = await Promise.all(HEADER_MODES.map((mode) => probe(normalizeBaseUrl(baseUrl), mode)));

  return {
    results,
    configured: parseHeaderMode(env.NEPALPAY_HEADER_MODE),
    working: results.filter((r) => r.verdict === 'API_REACHED').map((r) => r.mode),
  };
}
