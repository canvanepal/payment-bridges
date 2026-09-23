/**
 * ESM entry point for nepalpay.js.
 *
 *   import { createClient } from 'https://<your-worker>.workers.dev/nepalpay.mjs';
 *
 * The implementation lives in nepalpay.js so the same bytes serve a classic
 * <script> tag, a bundler, and this module entry point.
 */
import './nepalpay.js';

const api = globalThis.NepalPay;

export const version = api.version;
export const createClient = api.createClient;
export const payWidget = api.payWidget;
export const paymentStatus = api.paymentStatus;
export const NepalPayError = api.NepalPayError;
export const ROUTES = api.ROUTES;
export const HELP = api.HELP;

export default api;
