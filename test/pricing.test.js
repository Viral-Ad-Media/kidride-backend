const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSettings, computeFare, cancellationFee, DEFAULT_PRICING } = require('../lib/pricing');
const { estimateMetrics } = require('../lib/routeMetrics');

const settings = normalizeSettings({});
// 2026-10-21 is a Wednesday; New York is UTC-4 then.
const ny = (hhmm) => new Date(`2026-10-21T${hhmm}:00-04:00`);
const fare = (trip) => computeFare(settings, { serviceType: 'pickup_only', pickupTime: ny('11:00'), ...trip });

test('report example: off-peak 4 miles, 12 minutes is $17.70 and the driver gets $12.16', () => {
  const result = fare({ miles: 4, minutes: 12 });
  assert.equal(result.total, 17.7);
  assert.equal(result.driverEarnings, 12.16);
  assert.deepEqual(result.lines.map((line) => [line.key, line.amount]), [['trip', 15.2], ['booking_fee', 2.5]]);
});

test('school-run peak adds a flat fee that goes entirely to the driver', () => {
  const result = fare({ miles: 4, minutes: 12, pickupTime: ny('08:00') });
  assert.equal(result.total, 20.7);
  assert.equal(result.driverEarnings, 15.16);
  assert.equal(fare({ miles: 4, minutes: 12, pickupTime: ny('09:00') }).total, 17.7, 'window end is exclusive');
  assert.equal(fare({ miles: 4, minutes: 12, pickupTime: ny('14:30') }).total, 20.7);
});

test('report example: two siblings, 8 miles, 22 minutes at 15:00 is $35.20', () => {
  assert.equal(fare({ miles: 8, minutes: 22, extraChildren: 1, pickupTime: ny('15:00') }).total, 35.2);
});

test('report example: stay one hour then a 3 mile, 10 minute drop-off is $41.50', () => {
  const result = fare({ serviceType: 'stay_with_child_and_dropoff', miles: 3, minutes: 10, stayMinutes: 60 });
  assert.equal(result.total, 41.5);
  assert.match(result.lines[0].label, /^Minimum fare/);
  assert.equal(fare({ serviceType: 'stay_with_child_and_dropoff', miles: 3, minutes: 10, stayMinutes: 5 }).stayMinutes, 15, 'stay minimum applies');
});

test('service multipliers price pickup and drop-off as two legs with 10% off', () => {
  const result = fare({ serviceType: 'pickup_and_dropoff', miles: 4, minutes: 12 });
  assert.equal(result.lines[0].amount, 27.36);
  assert.equal(result.total, 29.86);
  assert.equal(fare({ serviceType: 'dropoff_only', miles: 4, minutes: 12 }).total, 17.7);
});

test('short trips pay the minimum fare and every rate is configurable, including currency', () => {
  assert.equal(fare({ miles: 0.5, minutes: 2 }).total, 17.5);
  const custom = normalizeSettings({ currency: 'GBP', baseFare: 3, perMile: 2, perMinute: 0, minimumFare: 0, bookingFee: 0, peakWindows: [] });
  const result = computeFare(custom, { serviceType: 'pickup_only', miles: 10, minutes: 30, pickupTime: ny('08:00') });
  assert.equal(result.total, 23);
  assert.equal(result.currency, 'GBP');
});

test('the total always equals the sum of the rounded lines', () => {
  for (let miles = 0; miles < 30; miles += 1.37) {
    const result = fare({ miles, minutes: Math.round(miles * 3.1), extraChildren: 2, pickupTime: ny('07:30') });
    assert.equal(result.total, Math.round(result.lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100);
  }
});

test('malformed settings are rejected with a clear message', () => {
  for (const bad of [{ perMile: -1 }, { perMile: '1.5' }, { currency: 'usd' }, { timezone: 'Mars/Base' }, { peakWindows: ['9:00-10:00'] }, { peakWindows: ['10:00-09:00'] }, { driverShare: 1.5 }, { serviceMultipliers: { pickup_only: 0 } }]) {
    assert.throws(() => normalizeSettings(bad), (error) => error.status === 400, JSON.stringify(bad));
  }
  assert.equal(normalizeSettings({ perMile: 1.005 }).perMile, 1.01);
  assert.deepEqual(normalizeSettings({}), normalizeSettings(DEFAULT_PRICING));
});

test('cancellation: free at first, $5 once a driver is assigned, half within an hour of a scheduled pickup', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const ahead = (min) => new Date(+now + min * 60000).toISOString();
  const base = { total: 20, createdAt: ago(30), pickupTime: ago(30), isScheduled: false, driverAssigned: true };
  assert.equal(cancellationFee(settings, { ...base, createdAt: ago(1) }, { now }), 0, 'grace period');
  assert.equal(cancellationFee(settings, base, { now }), 5);
  assert.equal(cancellationFee(settings, { ...base, driverAssigned: false }, { now }), 0);
  assert.equal(cancellationFee(settings, base, { now, byParent: false }), 0);
  const scheduled = { ...base, isScheduled: true, driverAssigned: false };
  assert.equal(cancellationFee(settings, { ...scheduled, pickupTime: ahead(9 * 60) }, { now }), 0);
  assert.equal(cancellationFee(settings, { ...scheduled, pickupTime: ahead(3 * 60) }, { now }), 0);
  assert.equal(cancellationFee(settings, { ...scheduled, pickupTime: ahead(3 * 60), driverAssigned: true }, { now }), 5);
  assert.equal(cancellationFee(settings, { ...scheduled, pickupTime: ahead(45) }, { now }), 10);
  assert.equal(cancellationFee(settings, { ...base, total: 3 }, { now }), 3, 'never more than the fare');
});

test('without Google the distance is a straight-line estimate with a road factor', () => {
  // About 1 mile due north.
  const result = estimateMetrics({ lat: 40, lng: -74 }, { lat: 40.014472, lng: -74 });
  assert.equal(result.source, 'estimate');
  assert.ok(Math.abs(result.miles - 1.3) < 0.01, String(result.miles));
  assert.equal(result.minutes, 4);
});

test('a local time of day can be priced directly (admin sample trip)', () => {
  assert.equal(fare({ miles: 4, minutes: 12, localMinutes: 8 * 60 }).total, 20.7);
  assert.equal(fare({ miles: 4, minutes: 12, localMinutes: 12 * 60, pickupTime: ny('08:00') }).total, 17.7);
});
