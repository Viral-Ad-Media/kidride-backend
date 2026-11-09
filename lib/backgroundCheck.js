const crypto = require('node:crypto');

// Background checks for drivers.
//   checkr  US: Checkr hosted invitation (criminal + motor vehicle record), when CHECKR_API_KEY is set.
//           The driver completes Checkr's form; Checkr's webhook reports clear or consider.
//   manual  Anywhere else (UK enhanced DBS, local police clearance): BACKGROUND_CHECK_MODE=manual.
//           The driver is told to send the certificate; an admin records the number and passes the check.
//   off     Neither set: no background check step (current behaviour).

const API = 'https://api.checkr.com/v1';
const mode = () => (process.env.CHECKR_API_KEY ? 'checkr' : process.env.BACKGROUND_CHECK_MODE === 'manual' ? 'manual' : 'off');

const checkr = async (path, body) => {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.CHECKR_API_KEY}:`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.error || `Background check provider error ${response.status}`), { status: 502 });
  return data;
};

/** Creates (or reuses) the Checkr candidate and an invitation; returns { candidateId, invitationUrl }. */
const startCheckr = async ({ candidateId, email, name }) => {
  const [first, ...rest] = String(name || '').trim().split(/\s+/);
  const candidate = candidateId ? { id: candidateId } : await checkr('/candidates', { email, first_name: first || undefined, last_name: rest.join(' ') || undefined });
  const invitation = await checkr('/invitations', {
    candidate_id: candidate.id,
    package: process.env.CHECKR_PACKAGE || 'driver_pro',
    work_locations: [{ country: 'US', ...(process.env.CHECKR_WORK_STATE ? { state: process.env.CHECKR_WORK_STATE } : {}) }]
  });
  return { candidateId: candidate.id, invitationUrl: invitation.invitation_url };
};

/**
 * Checkr webhook: verifies X-Checkr-Signature (HMAC-SHA256 of the body with the API key)
 * and returns { candidateId, result: 'clear' | 'consider' } for a completed report, else null.
 */
const parseCheckrWebhook = (rawBody, signature, key = process.env.CHECKR_API_KEY) => {
  if (!key) throw Object.assign(new Error('Checkr not configured'), { status: 503 });
  const expected = crypto.createHmac('sha256', key).update(rawBody).digest('hex');
  const given = String(signature || '');
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw Object.assign(new Error('Bad signature'), { status: 400 });
  const event = JSON.parse(rawBody);
  if (event.type !== 'report.completed') return null;
  const report = event.data?.object || {};
  return { candidateId: report.candidate_id, result: report.result === 'clear' || report.status === 'clear' ? 'clear' : 'consider', reportId: report.id };
};

module.exports = { mode, startCheckr, parseCheckrWebhook };
