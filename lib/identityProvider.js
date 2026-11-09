const crypto = require('node:crypto');

// Identity verification provider: checks a government ID and matches a live
// selfie to it. Stripe Identity is the provider; the rest of the app only uses
// isReady / createSession / fetchSession / parseWebhook, so another provider
// (Persona, Onfido, Veriff) can replace it behind the same four functions.
// Without STRIPE_SECRET_KEY the app falls back to admin review of live photos.

const API = 'https://api.stripe.com/v1';
const isReady = () => typeof process.env.STRIPE_SECRET_KEY === 'string' && process.env.STRIPE_SECRET_KEY.startsWith('sk_');

const form = (values, prefix = '', out = new URLSearchParams()) => {
  for (const [key, value] of Object.entries(values)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((item) => out.append(`${name}[]`, String(item)));
    else if (value && typeof value === 'object') form(value, name, out);
    else if (value !== undefined && value !== null) out.append(name, String(value));
  }
  return out;
};

const stripe = async (method, path, body) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? form(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Identity provider error ${response.status}`), { status: 502 });
  return data;
};

// Stripe session status -> ours: verified | processing | requires_input | canceled.
const toResult = (session) => ({
  sessionId: session.id,
  status: session.status === 'canceled' ? 'canceled' : session.status,
  url: session.url || null,
  // Why the provider could not verify (document unreadable, selfie mismatch...), for the driver and admin.
  error: session.last_error ? { code: session.last_error.code || null, reason: session.last_error.reason || null } : null,
  driverId: session.metadata?.driver_id || null
});

/** A hosted verification page: driving licence (live capture) + a selfie matched to it. */
const createSession = async ({ driverId, email, returnUrl }) => toResult(await stripe('POST', '/identity/verification_sessions', {
  type: 'document',
  metadata: { driver_id: driverId },
  ...(email ? { provided_details: { email } } : {}),
  options: { document: { allowed_types: ['driving_license'], require_live_capture: true, require_matching_selfie: true } },
  return_url: returnUrl
}));

const fetchSession = async (sessionId) => toResult(await stripe('GET', `/identity/verification_sessions/${encodeURIComponent(sessionId)}`));

/** Verifies the Stripe-Signature header on the raw body and returns the event's session result, or null for other events. */
const parseWebhook = (rawBody, signature, secret = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET, now = Date.now()) => {
  if (!secret) throw Object.assign(new Error('Webhook secret not set'), { status: 503 });
  const parts = Object.fromEntries(String(signature || '').split(',').map((part) => part.split('=')).filter((pair) => pair.length === 2).map(([k, v]) => [k, v]));
  const signatures = String(signature || '').split(',').filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  const timestamp = Number(parts.t);
  if (!timestamp || !signatures.length || Math.abs(now / 1000 - timestamp) > 300) throw Object.assign(new Error('Bad signature'), { status: 400 });
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const ok = signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!ok) throw Object.assign(new Error('Bad signature'), { status: 400 });
  const event = JSON.parse(rawBody);
  if (!String(event.type || '').startsWith('identity.verification_session.')) return null;
  return toResult(event.data.object);
};

module.exports = { isReady, createSession, fetchSession, parseWebhook };
