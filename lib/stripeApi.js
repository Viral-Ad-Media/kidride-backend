const crypto = require('node:crypto');

// Minimal Stripe REST client (no SDK): form-encoded requests, idempotency keys,
// and webhook signature checks. Used by lib/payments.js; Stripe Identity keeps
// its own copy in lib/identityProvider.js.

const API = 'https://api.stripe.com/v1';

const encode = (values, prefix = '', out = new URLSearchParams()) => {
  for (const [key, value] of Object.entries(values)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((item, index) => (item && typeof item === 'object' ? encode(item, `${name}[${index}]`, out) : out.append(`${name}[]`, String(item))));
    else if (value && typeof value === 'object') encode(value, name, out);
    else if (value !== undefined && value !== null) out.append(name, String(value));
  }
  return out;
};

/** Stripe error with the fields the payment flow needs: code, declineCode, paymentIntent. */
const stripeError = (data, status) => Object.assign(new Error(data?.error?.message || `Payment provider error ${status}`), {
  status: status >= 500 ? 502 : status,
  provider: true,
  code: data?.error?.code || null,
  declineCode: data?.error?.decline_code || null,
  paymentIntent: data?.error?.payment_intent || null
});

const request = async (method, path, body, { idempotencyKey, timeout = 20000 } = {}) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      // Pinned so a change to the account's default API version cannot change these responses.
      'Stripe-Version': '2024-06-20',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    body: body ? encode(body) : undefined,
    signal: AbortSignal.timeout(timeout)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw stripeError(data, response.status);
  return data;
};

const post = (path, body = {}, options) => request('POST', path, body, options);
const get = (path, options) => request('GET', path, null, options);

/** Verifies a Stripe-Signature header against any of the given secrets; returns the parsed event. */
const verifyEvent = (rawBody, signature, secrets, now = Date.now()) => {
  const usable = secrets.filter(Boolean);
  if (!usable.length) throw Object.assign(new Error('Webhook secret not set'), { status: 503 });
  const header = String(signature || '');
  const timestamp = Number((header.split(',').find((part) => part.startsWith('t=')) || '').slice(2));
  const signatures = header.split(',').filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!timestamp || !signatures.length || Math.abs(now / 1000 - timestamp) > 300) throw Object.assign(new Error('Bad signature'), { status: 400 });
  const ok = usable.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    return signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  });
  if (!ok) throw Object.assign(new Error('Bad signature'), { status: 400 });
  return JSON.parse(rawBody);
};

// Currencies Stripe counts in whole units (no cents). Three-decimal currencies are rare and not supported.
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const toMinor = (amount, currency) => Math.round(Number(amount) * (ZERO_DECIMAL.has(String(currency).toUpperCase()) ? 1 : 100));
const fromMinor = (minor, currency) => Number(minor) / (ZERO_DECIMAL.has(String(currency).toUpperCase()) ? 1 : 100);

module.exports = { post, get, verifyEvent, toMinor, fromMinor, encode };
