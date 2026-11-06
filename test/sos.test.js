const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeShareToken, hashToken, isTokenShaped, publicSosView, mapsLink, SHARE_HOURS } = require('../lib/sosShare');

const now = new Date(Date.UTC(2026, 10, 6, 18, 0));
const share = makeShareToken(now);
const incident = { kind: 'sos', reporter_role: 'parent', created_at: now.toISOString(), resolved_at: null, share_expires_at: share.expiresAt, location: { latitude: 40.71, longitude: -74.0 } };
const ride = {
  status: 'child_picked_up', pickup_location: 'School', dropoff_location: 'Home',
  driver: { name: 'Taylor Smith', phone: '+15550100', vehicle: { color: 'Blue', make: 'Toyota', model: 'Sienna', plate: 'KID 123' } },
  driver_location: { latitude: 40.72, longitude: -74.01, recordedAt: now.toISOString() },
  trip_code: '4821', parent_id: 'p1'
};

test('share tokens are random, URL-safe and stored only as a hash', () => {
  const other = makeShareToken(now);
  assert.notEqual(share.token, other.token);
  assert.ok(isTokenShaped(share.token));
  assert.equal(share.hash, hashToken(share.token));
  assert.notEqual(share.hash, share.token);
  assert.equal(new Date(share.expiresAt) - now, SHARE_HOURS * 3600 * 1000);
  assert.equal(isTokenShaped('../etc'), false);
  assert.equal(isTokenShaped(undefined), false);
});

test('the public view shows the live car position and first names only', () => {
  const view = publicSosView({ incident, ride, childName: 'Ada Lovelace' }, now);
  assert.equal(view.active, true);
  assert.equal(view.child, 'Ada');
  assert.equal(view.driver, 'Taylor');
  assert.equal(view.vehicle, 'Blue Toyota Sienna');
  assert.equal(view.plate, 'KID 123');
  assert.equal(view.location.latitude, 40.72, 'uses the driver GPS over the SOS position');
  const text = JSON.stringify(view);
  for (const secret of ['4821', '+15550100', 'Smith', 'Lovelace', 'p1']) assert.ok(!text.includes(secret), `leaks ${secret}`);
});

test('the public view falls back to the SOS position and stops when handled or expired', () => {
  assert.equal(publicSosView({ incident, ride: { ...ride, driver_location: null }, childName: 'Ada' }, now).location.latitude, 40.71);
  assert.equal(publicSosView({ incident: { ...incident, resolved_at: now.toISOString() }, ride }, now).active, false);
  const later = new Date(now.getTime() + (SHARE_HOURS * 3600 + 1) * 1000);
  assert.equal(publicSosView({ incident, ride }, later).active, false);
  assert.equal(publicSosView({ incident: { ...incident, kind: 'stalled' }, ride }, now), null, 'only SOS incidents have links');
  assert.equal(publicSosView({ incident: { ...incident, share_expires_at: null }, ride }, now).active, false);
});

test('maps links need real coordinates', () => {
  assert.equal(mapsLink({ latitude: 40.7128, longitude: -74.006 }), 'https://www.google.com/maps?q=40.712800,-74.006000');
  assert.equal(mapsLink(null), null);
  assert.equal(mapsLink({ latitude: 'x', longitude: 1 }), null);
});
