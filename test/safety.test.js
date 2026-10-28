const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSafety, tripCodeMatches, milesFromSegment, evaluatePosition, outranks, noShowTerms } = require('../lib/safety');
const { normalizeSettings } = require('../lib/pricing');

const safety = normalizeSafety({});
const pricing = normalizeSettings({});
// A trip due north in Manhattan, about 2.8 miles.
const pickup = { lat: 40.7128, lng: -74.006 };
const dropoff = { lat: 40.7536, lng: -73.9832 };
const onboard = (monitor) => ({ status: 'child_picked_up', pickup_coords: pickup, dropoff_coords: dropoff, monitor });
const at = (minutes) => new Date(Date.UTC(2026, 9, 22, 15, minutes));

test('trip codes match exactly, ignoring spaces', () => {
  assert.equal(tripCodeMatches('4821', '4821'), true);
  assert.equal(tripCodeMatches(' 48 21 ', '4821'), true);
  assert.equal(tripCodeMatches('4820', '4821'), false);
  assert.equal(tripCodeMatches('48210', '4821'), false);
  assert.equal(tripCodeMatches('', ''), false, 'a ride without a code never matches');
  assert.equal(tripCodeMatches(undefined, '4821'), false);
});

test('safety settings fall back to defaults and reject bad values', () => {
  assert.deepEqual(safety, { tripCodeMaxAttempts: 5, offRouteMiles: 1.5, stalledMinutes: 5, stalledRadiusMeters: 100, dropoffQuietMeters: 300 });
  assert.equal(normalizeSafety({ offRouteMiles: 0.5 }).offRouteMiles, 0.5);
  assert.throws(() => normalizeSafety({ tripCodeMaxAttempts: 0 }), /Trip code attempts/);
  assert.throws(() => normalizeSafety({ stalledMinutes: 2.5 }), /whole number/);
  assert.throws(() => normalizeSafety({ offRouteMiles: 'far' }), /Off-route/);
});

test('distance from the route is measured to the nearest point of the pickup-to-drop-off line', () => {
  const midpoint = { lat: (pickup.lat + dropoff.lat) / 2, lng: (pickup.lng + dropoff.lng) / 2 };
  assert.ok(milesFromSegment(midpoint, pickup, dropoff) < 0.01);
  // Two miles east of the pickup, which is past the start of the line.
  const east = { lat: pickup.lat, lng: pickup.lng + 2 / 52.4 };
  assert.ok(Math.abs(milesFromSegment(east, pickup, dropoff) - 1.75) < 0.2);
  assert.ok(milesFromSegment(pickup, pickup, pickup) === 0, 'a zero-length route is a point');
});

test('off route alerts once, then re-arms after the car comes back', () => {
  const far = { lat: 40.73, lng: -73.95 }; // about 2.3 miles east of the line
  const first = evaluatePosition(safety, onboard({}), far, at(0));
  assert.deepEqual(first.alerts.map((a) => a.kind), ['off_route']);
  assert.ok(first.alerts[0].details.milesFromRoute > 1.5);
  assert.deepEqual(evaluatePosition(safety, onboard(first.monitor), far, at(1)).alerts, [], 'no repeat while still off route');
  const back = evaluatePosition(safety, onboard(first.monitor), pickup, at(2));
  assert.equal(back.monitor.offRoute, false);
  assert.deepEqual(evaluatePosition(safety, onboard(back.monitor), far, at(3)).alerts.map((a) => a.kind), ['off_route']);
});

test('stalled fires after the configured minutes without moving, once per stop', () => {
  const spot = { lat: 40.725, lng: -74.0 };
  let { monitor, alerts } = evaluatePosition(safety, onboard({}), spot, at(0));
  assert.deepEqual(alerts, []);
  ({ monitor, alerts } = evaluatePosition(safety, onboard(monitor), { lat: spot.lat + 0.0003, lng: spot.lng }, at(4)));
  assert.deepEqual(alerts, [], '33 m drift after 4 minutes is not yet stalled');
  ({ monitor, alerts } = evaluatePosition(safety, onboard(monitor), spot, at(5)));
  assert.deepEqual(alerts.map((a) => a.kind), ['stalled']);
  assert.equal(alerts[0].details.stoppedMinutes, 5);
  ({ monitor, alerts } = evaluatePosition(safety, onboard(monitor), spot, at(9)));
  assert.deepEqual(alerts, [], 'one alert per stop');
  ({ monitor, alerts } = evaluatePosition(safety, onboard(monitor), { lat: 40.73, lng: -74.0 }, at(10)));
  assert.equal(monitor.stalled, false, 'moving on re-arms the check');
});

test('no stalled alert while parking at the drop-off, and no checks before the child is onboard', () => {
  let { monitor } = evaluatePosition(safety, onboard({}), dropoff, at(0));
  assert.deepEqual(evaluatePosition(safety, onboard(monitor), dropoff, at(20)).alerts, []);
  const before = evaluatePosition(safety, { ...onboard({}), status: 'driver_assigned' }, { lat: 41, lng: -75 }, at(0));
  assert.deepEqual(before.alerts, []);
});

test('SOS outranks every other alert on the ride flag', () => {
  assert.equal(outranks('sos', 'stalled'), true);
  assert.equal(outranks('stalled', 'sos'), false);
  assert.equal(outranks('off_route', null), true);
  assert.equal(outranks('trip_code', 'trip_code'), true);
});

test('no-show opens after the wait window and charges the fee, capped at the fare', () => {
  const ride = { status: 'driver_arrived_at_pickup', arrived_at: at(0).toISOString(), price: 17.7 };
  assert.deepEqual(noShowTerms(pricing, ride, at(9)), { allowed: false, availableAt: at(10).toISOString(), fee: 10 });
  assert.equal(noShowTerms(pricing, ride, at(10)).allowed, true);
  assert.equal(noShowTerms(pricing, { ...ride, price: 6 }, at(10)).fee, 6);
  assert.equal(noShowTerms(pricing, { ...ride, status: 'driver_assigned' }, at(30)).allowed, false);
  assert.equal(noShowTerms(pricing, { ...ride, arrived_at: null }, at(30)).allowed, false, 'rides that arrived before this change wait for support');
});

test('no-show rules live in the pricing cancellation settings', () => {
  assert.equal(pricing.cancellation.noShowWaitMinutes, 10);
  assert.equal(pricing.cancellation.noShowFee, 10);
  assert.equal(normalizeSettings({ cancellation: { noShowFee: 12.5 } }).cancellation.noShowFee, 12.5);
  assert.throws(() => normalizeSettings({ cancellation: { noShowWaitMinutes: 500 } }), /No-show wait/);
});
