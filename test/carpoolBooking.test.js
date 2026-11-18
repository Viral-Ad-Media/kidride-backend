// Booking through the real handler (routes/rideRoutes.js), with stand-ins for
// everything that needs a database or the network: the ride of a carpool, and a
// ride booked with a promo code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const pricing = require('../lib/pricing');
const security = require('../lib/security');
const { quoteAllServices } = require('../lib/fareQuotes');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const home = { lat: 6.5, lng: 3.3 };
const school = { lat: 6.52, lng: 3.35 };
// A bookable time: three hours ahead, on a 5-minute step.
const when = new Date(Math.ceil((Date.now() + 3 * 60 * 60000) / 300000) * 300000).toISOString();
const pool = { id: 'pool-1', organiser_id: 'p1', name: 'Saturday football', pickup_location: '12 Oak Street', pickup_coords: home, dropoff_location: 'City Stadium', dropoff_coords: school, pickup_time: when, seats: 4, invite_code: 'ABC234', status: 'open', ride_id: null };
const members = [
  { carpool_id: 'pool-1', parent_id: 'p2', child_ids: ['c3'], joined_at: '2026-11-18T09:10:00Z' },
  { carpool_id: 'pool-1', parent_id: 'p1', child_ids: ['c1', 'c2'], joined_at: '2026-11-18T09:00:00Z' }
];
const trip = { pickupCoords: home, dropoffCoords: school, pickupAddress: pool.pickup_location, dropoffAddress: pool.dropoff_location, scheduledAt: when, stayMinutes: 0 };
const quoteFor = async (parentId, childCount) => (await quoteAllServices(pricing.normalizeSettings({}), parentId, { ...trip, childCount })).quotes.pickup_only;

const bookingHandler = (db, created) => {
  const handlers = {};
  const router = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (url, ...args) => { handlers[method + ' ' + url] = args.at(-1); }]));
  const mocks = {
    express: { Router: () => router },
    '../middleware/authMiddleware': { protect() {} },
    '../middleware/rateLimitMiddleware': { createRateLimiter: () => () => {}, parsePositiveInt: (_, fallback) => fallback },
    '../config/supabase': { supabaseAdmin: db },
    '../lib/repository': { fetchRideRowById: async (id) => ({ id, dispatch_state: 'open', ...created.row }), formatRide: (ride) => ride, formatRideFor: (_user, ride) => ride },
    '../lib/security': security,
    '../lib/push': { notifyRide: async () => {} },
    '../lib/notifications': { notifyRideEvent: async (_ride, event) => { created.notified = event; } },
    '../lib/ratings': { fetchRatingSummaries: async () => new Map(), fetchFamilyRatingSummaries: async () => new Map() },
    '../lib/pricingSettings': { loadPricing: async () => pricing.normalizeSettings({}) },
    '../lib/dispatch': { advanceDispatch: async () => {}, releaseDueScheduledRides: async () => 0, findNearbyDrivers: async () => [] },
    '../lib/safetySettings': { loadSafety: async () => require('../lib/safety').normalizeSafety({}) },
    '../lib/seriesGenerator': { generateForParent: async () => 0, generateAll: async () => 0 },
    '../lib/incidents': { recordIncident: async (ride) => ({ incident: {}, ride }), listIncidents: async () => [], resolveIncidents: async () => null },
    '../lib/driverChecks': { flag: async () => [] },
    '../lib/subscriptions': { priceForParent: async (_id, fare) => ({ fare, discount: 0 }) },
    '../lib/payments': { requireCard: async () => {} },
    '../lib/driverPhoto': { driverPhotoUrl: async () => null }
  };
  const filename = path.join(__dirname, '..', 'routes/rideRoutes.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: (name) => (Object.hasOwn(mocks, name) ? mocks[name] : require(name)), process, console, Date, Set }, { filename });
  return handlers['post /request'];
};

// The database for a booking: the carpool and promotion tables to read, and the rides table to count and insert into.
const bookingDb = (created, { promotions = [] } = {}) => ({
  from: (table) => {
    let rows = table === 'carpools' ? [pool] : table === 'carpool_members' ? [...members] : table === 'promotions' ? [...promotions] : [];
    const query = {
      select: () => query,
      limit: () => query,
      eq: (column, value) => { rows = rows.filter((row) => row[column] === undefined || row[column] === value); return query; },
      in: (column, values) => { rows = rows.filter((row) => row[column] === undefined || values.includes(row[column])); return query; },
      is: (column, value) => { rows = rows.filter((row) => row[column] === undefined || (row[column] ?? null) === value); return query; },
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      single: async () => ({ data: { id: 'ride-new' }, error: null }),
      insert: (row) => { if (table === 'promotion_redemptions') created.redemption = row; else created.row = row; return query; },
      update: (change) => { created.carpoolChange = change; return query; },
      then: (resolve) => resolve({ data: rows, count: 0, error: null })
    };
    return query;
  }
});
const reply = () => ({ code: 200, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
const request = (user, body) => ({ user, body, app: { get: () => null } });
const organiser = { role: 'parent', id: 'p1', children: [{ id: 'c1' }, { id: 'c2' }] };

test('the organiser books one ride that carries every family\'s children on the carpool\'s own trip', async () => {
  const quote = await quoteFor('p1', 3);
  const created = {};
  const handler = bookingHandler(bookingDb(created), created);
  const res = reply();
  // The request names another place and only one child: none of that is used.
  await handler(request(organiser, { carpoolId: 'pool-1', quoteToken: quote.quoteToken, scheduled: true, childIds: ['c1'], pickup: 'Somewhere else', dropoff: 'Another place' }), res);
  assert.equal(res.code, 201, JSON.stringify(res.body));
  // (Spread: the handler runs in its own context, so its arrays are not this file's Array.)
  assert.deepEqual([...created.row.child_ids], ['c1', 'c2', 'c3']);
  assert.equal(created.row.child_id, 'c1');
  assert.equal(created.row.parent_id, 'p1');
  assert.equal(created.row.pickup_location, '12 Oak Street');
  assert.equal(created.row.dropoff_location, 'City Stadium');
  assert.equal(created.row.pickup_time, when);
  assert.equal(created.row.is_scheduled, true);
  assert.equal(created.row.service_type, 'pickup_only');
  assert.equal(created.row.price, quote.total);
  assert.equal(created.carpoolChange.ride_id, 'ride-new');
  assert.equal(created.carpoolChange.status, 'booked');
  assert.equal(created.notified, 'booked');
});

test('a family in the carpool cannot book it, and a fare priced for fewer children is refused', async () => {
  const created = {};
  const handler = bookingHandler(bookingDb(created), created);

  const member = reply();
  await handler(request({ role: 'parent', id: 'p2', children: [{ id: 'c3' }] }, { carpoolId: 'pool-1', quoteToken: (await quoteFor('p2', 3)).quoteToken, scheduled: true }), member);
  assert.equal(member.code, 403);
  assert.equal(created.row, undefined);

  // Priced before the last family joined: the organiser has to see the new fare first.
  const stale = reply();
  await handler(request(organiser, { carpoolId: 'pool-1', quoteToken: (await quoteFor('p1', 2)).quoteToken, scheduled: true }), stale);
  assert.equal(stale.code, 409);
  assert.equal(created.row, undefined);

  // Three hours ahead it cannot go out as a ride for now.
  const early = reply();
  await handler(request(organiser, { carpoolId: 'pool-1', quoteToken: (await quoteFor('p1', 3)).quoteToken, scheduled: false }), early);
  assert.equal(early.code, 409);
  assert.equal(created.row, undefined);
});

test('without a carpool, another family\'s child is still refused', async () => {
  const created = {};
  const handler = bookingHandler(bookingDb(created), created);
  const res = reply();
  await handler(request({ role: 'parent', id: 'p1', children: [{ id: 'c1' }] }, { childIds: ['c1', 'c3'], pickup: 'A', dropoff: 'B' }), res);
  assert.equal(res.code, 403);
  assert.equal(created.row, undefined);
});

// ---- A ride booked with a promo code ----

const summer = { id: 'promo-1', title: 'Summer 10% off', code: 'SUMMER10', percent_off: 10, max_discount: null, audience: 'all', starts_at: '2026-01-01T00:00:00Z', ends_at: null, max_uses_per_user: null, max_uses_total: null, active: true };
const ownRide = async () => ({ childIds: ['c1'], pickup: pool.pickup_location, dropoff: pool.dropoff_location, pickupCoords: home, dropoffCoords: school, scheduled: true, pickupTime: when, serviceType: 'pickup_only', quoteToken: (await quoteFor('p1', 1)).quoteToken });

test('a promo code takes its percentage off the booked fare, leaves the driver\'s pay alone and is recorded', async () => {
  const quote = await quoteFor('p1', 1);
  const created = {};
  const handler = bookingHandler(bookingDb(created, { promotions: [summer] }), created);
  const res = reply();
  await handler(request(organiser, { ...(await ownRide()), promoCode: 'summer10' }), res);
  assert.equal(res.code, 201, JSON.stringify(res.body));
  const off = Math.round(quote.total * 10) / 100;
  assert.equal(created.row.price, Math.round((quote.total - off) * 100) / 100);
  assert.equal(created.row.driver_earnings, quote.driverEarnings);
  assert.equal(created.row.subscription_discount, undefined);
  const line = [...created.row.fare_breakdown.lines].at(-1);
  assert.equal(line.key, 'promo');
  assert.equal(line.amount, -off);
  assert.equal(created.redemption.promotion_id, 'promo-1');
  assert.equal(created.redemption.parent_id, 'p1');
  assert.equal(created.redemption.ride_id, 'ride-new');
  assert.equal(created.redemption.amount, off);
});

test('a promo code that cannot be used stops the booking instead of charging the full fare unannounced', async () => {
  const created = {};
  const handler = bookingHandler(bookingDb(created, { promotions: [{ ...summer, active: false }] }), created);
  const res = reply();
  await handler(request(organiser, { ...(await ownRide()), promoCode: 'SUMMER10' }), res);
  assert.equal(res.code, 409);
  assert.match(res.body.message, /not active/);
  assert.equal(created.row, undefined);

  // Without a code the same ride books at the normal fare.
  const plain = reply();
  await handler(request(organiser, await ownRide()), plain);
  assert.equal(plain.code, 201);
  assert.equal(created.row.price, (await quoteFor('p1', 1)).total);
  assert.equal(created.redemption, undefined);
});
