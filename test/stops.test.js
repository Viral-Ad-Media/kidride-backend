const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const stops = require('../lib/stops');
const pricing = require('../lib/pricing');
const { estimateMetrics } = require('../lib/routeMetrics');
const { tripKey } = require('../lib/fareQuotes');
const { evaluatePosition, normalizeSafety } = require('../lib/safety');
const { redactOffer } = require('../lib/security');

const school = { address: 'Lincoln School', coords: { lat: 51.51, lng: -0.12 } };
const club = { address: 'City Swim Club', coords: { lat: 51.52, lng: -0.11 } };

test('stops need a picked place, at most three, and children from the ride', () => {
  assert.deepEqual(stops.parseStops(undefined), { stops: [] });
  assert.match(stops.parseStops([school, club, school, club]).error, /up to 3/);
  assert.match(stops.parseStops([{ address: 'Somewhere' }]).error, /suggestions/);
  assert.match(stops.parseStops([{ ...school, childIds: ['x'] }], { childIds: ['a'] }).error, /on this ride/);
  const { stops: parsed } = stops.parseStops([{ ...school, childIds: ['a', 'a'], note: '  Front gate ' }], { childIds: ['a', 'b'] });
  assert.deepEqual(parsed, [{ address: 'Lincoln School', coords: school.coords, note: 'Front gate', childIds: ['a'] }]);
  // Quotes do not know the children, so names are dropped rather than refused.
  assert.deepEqual(stops.parseStops([{ ...school, childIds: ['x'] }]).stops[0].childIds, []);
});

test('a stop cannot repeat the place before or after it', () => {
  const pickup = { address: 'Home', coords: { lat: 51.50, lng: -0.13 } };
  const dropoff = { address: 'Gran', coords: { lat: 51.53, lng: -0.10 } };
  assert.equal(stops.routeHasRepeat(pickup, [school, club], dropoff), false);
  assert.equal(stops.routeHasRepeat(pickup, [school, school], dropoff), true);
  assert.equal(stops.routeHasRepeat(pickup, [{ ...dropoff }], dropoff), true);
});

test('drivers arrive at and finish stops in order, only with the children onboard', () => {
  const ride = { status: 'child_picked_up', stops: stops.freshStops([school, club]) };
  assert.equal(stops.advanceStop({ ...ride, status: 'driver_assigned' }, 0, 'arrive').status, 409);
  assert.match(stops.advanceStop(ride, 1, 'arrive').error, /stop 1 first/);
  const arrived = stops.advanceStop(ride, 0, 'arrive');
  assert.equal(arrived.stops[0].status, 'arrived');
  assert.equal(stops.advanceStop({ ...ride, stops: arrived.stops }, 0, 'arrive').status, 409);
  const done = stops.advanceStop({ ...ride, stops: arrived.stops }, 0, 'complete');
  assert.equal(done.stops[0].status, 'done');
  assert.equal(done.stops[0].arrivedAt, arrived.stops[0].arrivedAt);
  assert.equal(stops.nextStopIndex(done.stops), 1);
  assert.equal(stops.pendingStops(done.stops), 1);
  // Finishing without a separate arrival records both times.
  const skipArrive = stops.advanceStop({ ...ride, stops: done.stops }, 1, 'complete');
  assert.ok(skipArrive.stops[1].arrivedAt);
  assert.equal(stops.nextStopIndex(skipArrive.stops), -1);
  assert.equal(stops.advanceStop(ride, 0, 'skip').status, 400);
});

test('the fare covers the whole route through the stops plus a fee per stop', () => {
  const settings = pricing.normalizeSettings({});
  const direct = pricing.computeFare(settings, { serviceType: 'pickup_only', miles: 6, minutes: 20, localMinutes: 12 * 60 });
  const twoStops = pricing.computeFare(settings, { serviceType: 'pickup_only', miles: 8, minutes: 30, localMinutes: 12 * 60, stopCount: 2 });
  assert.equal(twoStops.lines.find((l) => l.key === 'stops').amount, 4);
  assert.match(twoStops.lines[0].label, /via 2 stops/);
  // 2 extra miles x 1.50 + 10 min x 0.35 + 2 stops x 2.00
  assert.equal(Math.round((twoStops.total - direct.total) * 100) / 100, 10.5);
  assert.equal(twoStops.driverEarnings, pricing.round2((twoStops.total - settings.bookingFee) * settings.driverShare));
  assert.equal(pricing.normalizeSettings({ stopFee: 0 }).stopFee, 0);
  assert.throws(() => pricing.normalizeSettings({ stopFee: -1 }), /Extra stop fee/);
});

test('the estimate adds up each leg, and a quote with stops is a different trip', () => {
  const a = { lat: 51.50, lng: -0.13 }, b = { lat: 51.53, lng: -0.10 };
  assert.ok(estimateMetrics(a, b, [{ lat: 51.50, lng: -0.05 }]).miles > estimateMetrics(a, b).miles * 1.5);
  const trip = { serviceType: 'pickup_only', pickupCoords: a, dropoffCoords: b, childCount: 1 };
  assert.equal(tripKey({ ...trip, stops: [] }), tripKey(trip));
  assert.notEqual(tripKey({ ...trip, stops: [school] }), tripKey(trip));
  assert.notEqual(tripKey({ ...trip, stops: [school, club] }), tripKey({ ...trip, stops: [club, school] }));
});

test('route watch follows the stops: no off-route, stalled or drive-past alarms for them', () => {
  const settings = normalizeSafety({});
  const pickup = { lat: 51.50, lng: -0.20 }, dropoff = { lat: 51.50, lng: -0.10 };
  const detour = { address: 'Club', coords: { lat: 51.55, lng: -0.15 } }; // ~3.5 mi off the direct line
  const base = { status: 'child_picked_up', pickup_coords: pickup, dropoff_coords: dropoff, monitor: {} };
  const t0 = new Date('2026-11-16T15:00:00Z');
  assert.ok(evaluatePosition(settings, base, detour.coords, t0).alerts.some((a) => a.kind === 'off_route'));
  const withStop = { ...base, stops: stops.freshStops([detour]) };
  assert.deepEqual(evaluatePosition(settings, withStop, detour.coords, t0).alerts, []);
  // Waiting ten minutes at the stop is not a stalled car.
  const first = evaluatePosition(settings, withStop, detour.coords, t0);
  const later = evaluatePosition(settings, { ...withStop, monitor: first.monitor }, detour.coords, new Date(t0.getTime() + 10 * 60000));
  assert.equal(later.alerts.some((a) => a.kind === 'stalled'), false);
  // Passing the drop-off on the way to a stop beyond it is not a drive-past.
  const beyond = { ...base, stops: stops.freshStops([{ address: 'Far', coords: { lat: 51.50, lng: -0.05 } }]) };
  const m1 = evaluatePosition(settings, beyond, dropoff, t0).monitor;
  const m2 = evaluatePosition(settings, { ...beyond, monitor: m1 }, { lat: 51.50, lng: -0.07 }, new Date(t0.getTime() + 60000));
  assert.equal(m2.alerts.some((a) => a.kind === 'overshoot'), false);
  // Running late allows extra time per stop.
  assert.equal(first.monitor.expectedMinutes, evaluatePosition(settings, base, pickup, t0).monitor.expectedMinutes + 5);
});

test('drivers offered a ride see stop addresses but not which children get out', () => {
  const offer = redactOffer({ id: 'r', childIds: ['a'], stops: [{ index: 0, address: 'Lincoln School', note: 'Ava, front gate', childIds: ['a'], status: 'pending' }] });
  assert.deepEqual(offer.stops, [{ index: 0, address: 'Lincoln School', status: 'pending' }]);
});
