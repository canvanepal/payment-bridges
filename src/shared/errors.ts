/** Response envelope shared by both bridges. */
export interface BridgeEnvelope<T = unknown> {
  code: string;
  status: string;
  message: string;
  timeStamp: string;
  data: T;
  errors: unknown[];
}

export function errorBody(
  code: string,
  message: string,
  errors: unknown[] = [],
): BridgeEnvelope<null> {
  return {
    code,
    status: 'FAILED',
    message,
    timeStamp: new Date().toISOString(),
    data: null,
    errors,
  };
}

export function successBody<T>(message: string, data: T): BridgeEnvelope<T> {
  return {
    code: '000',
    status: 'SUCCESS',
    message,
    timeStamp: new Date().toISOString(),
    data,
    errors: [],
  };
}

export const secretMissing = () =>
  errorBody('NOT_CONFIGURED', 'SESSION_SECRET is not set. Run: wrangler secret put SESSION_SECRET');
