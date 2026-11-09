const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/ratingRules');
const { validSubscription } = require('../lib/webPush');

test('ratings accept compliments for 4-5 stars and issues for 1-3 stars only', () => {
  assert.deepEqual(rules.parseRating({ stars: 5, tags: ['safe_driving', 'safe_driving', 'on_time'], comment: ' Great ' }, rules.DRIVER_TAGS), { stars: 5, tags: ['safe_driving', 'on_time'], comment: 'Great' });
  assert.ok(rules.parseRating({ stars: 5, tags: ['late'] }, rules.DRIVER_TAGS).error);
  assert.ok(rules.parseRating({ stars: 2, tags: ['friendly'] }, rules.DRIVER_TAGS).error);
  assert.deepEqual(rules.parseRating({ stars: 2, tags: ['late'] }, rules.DRIVER_TAGS).tags, ['late']);
  assert.ok(rules.parseRating({ stars: 4, tags: ['ready_on_time'] }, rules.DRIVER_TAGS).error);
  assert.equal(rules.parseRating({ stars: 4, tags: ['ready_on_time'] }, rules.FAMILY_TAGS).error, undefined);
  for (const stars of [0, 6, 2.5, '5x']) assert.ok(rules.parseRating({ stars }, rules.DRIVER_TAGS).error);
  assert.ok(rules.parseRating({ stars: 5, tags: 'safe_driving' }, rules.DRIVER_TAGS).error);
  assert.ok(rules.parseRating({ stars: 5, tags: ['__proto__'] }, rules.DRIVER_TAGS).error);
});

test('summary averages the most recent ratings and counts compliments', () => {
  const rows = [...Array(rules.ROLLING_WINDOW).fill({ stars: 5, tags: ['on_time'] }), ...Array(50).fill({ stars: 1, tags: ['late'] })];
  const summary = rules.summarizeRatings(rows);
  assert.equal(summary.count, rules.ROLLING_WINDOW + 50);
  assert.equal(summary.average, 5);
  assert.deepEqual(summary.compliments, [{ tag: 'on_time', label: 'On time', count: rules.ROLLING_WINDOW }]);
  assert.equal(rules.summarizeRatings([]).average, null);
});

test('drivers under the review line after enough ratings are flagged', () => {
  const low = rules.summarizeRatings(Array.from({ length: 10 }, (_, i) => ({ stars: i < 6 ? 5 : 3, tags: [] })));
  assert.equal(rules.needsReview(low), true);
  assert.equal(rules.needsReview(rules.summarizeRatings([{ stars: 1, tags: [] }])), false);
});

test('rating window closes after the set number of days', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  assert.equal(rules.ratingWindowOpen({ updated_at: '2026-11-10T00:00:00Z' }, now), true);
  assert.equal(rules.ratingWindowOpen({ updated_at: '2026-10-01T00:00:00Z' }, now), false);
});

test('push subscriptions must be https with base64url keys', () => {
  const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'BNc2xYz_abcdefghijk-lmn', auth: 'abcdEFGH12' } };
  assert.equal(validSubscription(good), true);
  assert.equal(validSubscription({ ...good, endpoint: 'http://x.example/abc' }), false);
  assert.equal(validSubscription({ ...good, keys: { ...good.keys, auth: 'bad key!' } }), false);
  assert.equal(validSubscription(null), false);
});
