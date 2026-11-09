const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { planChecks, expandForProvider, pickActions, onlineReasons, blocksDriving, platesMatch, expiringDocuments, RULES } = require('../lib/reverification');
const { parseCheckrWebhook } = require('../lib/backgroundCheck');
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

test('going online: renewal, far away, new device, inactivity and spot checks', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const daysAgo = (d) => new Date(now - d * 86400000).toISOString();
  assert.deepEqual(onlineReasons(settings, { identityVerifiedAt: daysAgo(400), lastOnlineAt: daysAgo(1) }, now, () => 0.99), ['identity_renewal']);
  assert.deepEqual(onlineReasons(settings, { identityVerifiedAt: daysAgo(10), lastOnlineAt: daysAgo(45) }, now, () => 0.99), ['inactivity']);
  assert.deepEqual(onlineReasons(settings, { lastOnlineAt: daysAgo(1), metersFromLastFix: 250000 }, now, () => 0.99), ['far_location']);
  assert.deepEqual(onlineReasons(settings, { lastOnlineAt: daysAgo(1), metersFromLastFix: 5000 }, now, () => 0.99), []);
  assert.deepEqual(onlineReasons(settings, { lastOnlineAt: daysAgo(1), deviceId: 'new-device-1', knownDevices: ['old-device-1'] }, now, () => 0.99), ['new_device']);
  assert.deepEqual(onlineReasons(settings, { lastOnlineAt: daysAgo(1), deviceId: 'first-device', knownDevices: [] }, now, () => 0.99), [], 'the first device is learned, not flagged');
  assert.deepEqual(onlineReasons(settings, { lastOnlineAt: daysAgo(1) }, now, () => 0.01), ['spot_check']);
  assert.deepEqual(onlineReasons(settings, { lastOnlineAt: daysAgo(1), lastSpotCheckAt: daysAgo(2) }, now, () => 0.01), [], 'not twice in a week');
});

test('plates match ignoring spacing and case, with one misread character', () => {
  assert.equal(platesMatch('kdr123', 'KDR 123'), true);
  assert.equal(platesMatch('KDR-l23', 'KDR 123'), true);
  assert.equal(platesMatch('KDR12', 'KDR 123'), true);
  assert.equal(platesMatch('ABC999', 'KDR 123'), false);
  assert.equal(platesMatch('', 'KDR 123'), false);
});

test('documents expiring within the reminder window', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  assert.deepEqual(expiringDocuments({ license_expires_on: '2026-11-20', insurance_expires_on: '2027-05-01' }, 14, now), [{ kind: 'id_document', expiresOn: '2026-11-20' }]);
  assert.deepEqual(expiringDocuments({ license_expires_on: null, insurance_expires_on: '2026-11-01' }, 14, now), [{ kind: 'insurance_document', expiresOn: '2026-11-01' }]);
  assert.deepEqual(expiringDocuments(null, 14, now), []);
});

test('new drivers get a background check when one is switched on', () => {
  assert.deepEqual(expandForProvider(planChecks('onboarding'), true, 'checkr', 'onboarding').checks, ['identity', 'liveness', 'background']);
  assert.deepEqual(expandForProvider(planChecks('onboarding'), true, 'off', 'onboarding').checks, ['identity', 'liveness']);
});

test('Checkr webhooks are signed with the API key', () => {
  const body = JSON.stringify({ type: 'report.completed', data: { object: { id: 'r1', candidate_id: 'c1', result: 'clear' } } });
  const sig = crypto.createHmac('sha256', 'key').update(body).digest('hex');
  assert.deepEqual(parseCheckrWebhook(body, sig, 'key'), { candidateId: 'c1', result: 'clear', reportId: 'r1' });
  assert.throws(() => parseCheckrWebhook(body, 'bad', 'key'), /Bad signature/);
});

test('which checks stop new rides', () => {
  assert.equal(blocksDriving({ status: 'pending', clears: 'submit' }), true);
  assert.equal(blocksDriving({ status: 'submitted', clears: 'submit' }), false);
  assert.equal(blocksDriving({ status: 'submitted', clears: 'review' }), true);
  assert.equal(blocksDriving({ status: 'failed', clears: 'submit' }), true);
  assert.equal(blocksDriving({ status: 'passed', clears: 'review' }), false);
  const now = new Date('2026-11-09T12:00:00Z');
  assert.equal(blocksDriving({ status: 'pending', clears: 'review', due_at: '2026-11-20T23:59:59Z' }, now), false, 'expiring document: not yet');
  assert.equal(blocksDriving({ status: 'pending', clears: 'review', due_at: '2026-11-01T23:59:59Z' }, now), true, 'expired document blocks');
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
