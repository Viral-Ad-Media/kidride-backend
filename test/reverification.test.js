const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { planChecks, expandForProvider, pickActions, onlineReason, blocksDriving, RULES } = require('../lib/reverification');
const { normalizeSafety } = require('../lib/safety');
const { parseWebhook } = require('../lib/identityProvider');

const settings = normalizeSafety({});

test('each reason maps to its checks, and repeats escalate', () => {
  assert.deepEqual(planChecks('overshoot'), { checks: ['liveness', 'location_photo'], clears: 'review', repeated: false });
  assert.equal(planChecks('off_route', 1), null, 'one off-route alert alone asks for nothing');
  assert.deepEqual(planChecks('off_route', 2).checks, ['liveness', 'location_photo']);
  assert.deepEqual(planChecks('low_rating', 1).checks, ['liveness']);
  assert.deepEqual(planChecks('low_rating', 2), { checks: ['identity', 'vehicle_photo'], clears: 'review', repeated: true });
  assert.equal(planChecks('unknown'), null);
  for (const [reason, rule] of Object.entries(RULES)) assert.ok(rule.label, `${reason} has a label`);
});

test('without an identity provider, an ID check becomes a licence photo plus a face check for admin review', () => {
  assert.deepEqual(expandForProvider(planChecks('parent_sos'), false), { checks: ['id_document', 'liveness', 'vehicle_photo', 'plate_photo'], clears: 'review', repeated: false });
  assert.deepEqual(expandForProvider(planChecks('parent_sos'), true).checks, ['identity', 'vehicle_photo', 'plate_photo']);
});

test('liveness challenges pick three different random actions', () => {
  const actions = pickActions();
  assert.equal(actions.length, 3);
  assert.equal(new Set(actions).size, 3);
});

test('going online: renewal, inactivity and spot checks', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const daysAgo = (d) => new Date(now - d * 86400000).toISOString();
  assert.equal(onlineReason(settings, { identityVerifiedAt: daysAgo(400), lastOnlineAt: daysAgo(1) }, now, () => 0.99), 'identity_renewal');
  assert.equal(onlineReason(settings, { identityVerifiedAt: daysAgo(10), lastOnlineAt: daysAgo(45) }, now, () => 0.99), 'inactivity');
  assert.equal(onlineReason(settings, { lastOnlineAt: daysAgo(1) }, now, () => 0.01), 'spot_check');
  assert.equal(onlineReason(settings, { lastOnlineAt: daysAgo(1), lastSpotCheckAt: daysAgo(2) }, now, () => 0.01), null, 'not twice in a week');
  assert.equal(onlineReason(settings, { lastOnlineAt: daysAgo(1) }, now, () => 0.5), null);
});

test('which checks stop new rides', () => {
  assert.equal(blocksDriving({ status: 'pending', clears: 'submit' }), true);
  assert.equal(blocksDriving({ status: 'submitted', clears: 'submit' }), false);
  assert.equal(blocksDriving({ status: 'submitted', clears: 'review' }), true);
  assert.equal(blocksDriving({ status: 'failed', clears: 'submit' }), true);
  assert.equal(blocksDriving({ status: 'passed', clears: 'review' }), false);
});

test('identity webhooks need a valid recent Stripe signature', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ type: 'identity.verification_session.verified', data: { object: { id: 'vs_1', status: 'verified', metadata: { driver_id: 'd1' } } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.deepEqual(parseWebhook(body, `t=${t},v1=${sig}`, secret), { sessionId: 'vs_1', status: 'verified', url: null, error: null, driverId: 'd1' });
  assert.throws(() => parseWebhook(body, `t=${t},v1=${'0'.repeat(64)}`, secret), /Bad signature/);
  assert.throws(() => parseWebhook(body, `t=${t - 1000},v1=${sig}`, secret), /Bad signature/);
});
