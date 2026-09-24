/**
 * ESM entry point for fonepay.js.
 *
 *   import { createClient } from 'https://<your-worker>.workers.dev/fonepay.mjs';
 *
 * The implementation lives in fonepay.js so the same bytes serve a classic
 * <script> tag, a bundler, and this module entry point.
 */
import './fonepay.js';

const api = globalThis.Fonepay;

export const version = api.version;
export const createClient = api.createClient;
export const payWidget = api.payWidget;
export const FonepayError = api.FonepayError;
export const ROUTES = api.ROUTES;
export const HELP = api.HELP;
export const BRIDGE_KEY_HEADER = api.BRIDGE_KEY_HEADER;

export default api;
