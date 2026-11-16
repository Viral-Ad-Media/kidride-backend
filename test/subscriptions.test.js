const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PRICING, normalizeSettings: normalizePricing, computeFare } = require('../lib/pricing');
const subs = require('../lib/subscriptions');

const pricing = normalizePricing(DEFAULT_PRICING);
const settings = subs.normalizeSettings(subs.DEFAULT_SETTINGS);
const termsOf = (plan) => ({ ...plan, minProfitPerRide: settings.minProfitPerRide, cardFeePercent: settings.cardFeePercent, cardFeeFixed: settings.cardFeeFixed });
const fareFor = (serviceType, miles, minutes, extraChildren = 0, localMinutes = 600) => computeFare(pricing, { serviceType, miles, minutes, extraChildren, localMinutes });

test('default plans are valid and admin input is checked', () => {
  assert.equal(settings.plans.length, 3);
  assert.throws(() => subs.normalizeSettings({ plans: [{ id: 'x', name: 'X', monthlyPrice: 5, discountPercent: 10, ridesPerWeek: 5, maxDiscountPerRide: 3 }] }), /id must be/);
  assert.throws(() => subs.normalizeSettings({ plans: [{ id: 'aa', name: 'A', monthlyPrice: 5, discountPercent: 80, ridesPerWeek: 5, maxDiscountPerRide: 3 }] }), /discount/);
  assert.throws(() => subs.normalizeSettings({ plans: [{ id: 'aa', name: 'A', monthlyPrice: 5, discountPercent: 10, ridesPerWeek: 2.5, maxDiscountPerRide: 3 }] }), /whole number/);
  const dupe = { id: 'aa', name: 'A', monthlyPrice: 5, discountPercent: 10, ridesPerWeek: 5, maxDiscountPerRide: 3 };
  assert.throws(() => subs.normalizeSettings({ plans: [dupe, dupe] }), /own id/);
});

test('a typical ride gets the plan percentage, and the driver keeps full earnings', () => {
  const plan = termsOf(settings.plans.find((p) => p.id === 'school_week'));
  const fare = fareFor('pickup_only', 5, 15); // $5 + $7.50 + $5.25 = $17.75 + $2.50 = $20.25
  const { amount } = subs.rideDiscount(plan, fare);
  assert.equal(amount, 2.03);
  const out = subs.applyDiscount(fare, amount, plan);
  assert.equal(out.total, 18.22);
  assert.equal(out.driverEarnings, fare.driverEarnings);
  assert.equal(out.lines.at(-1).key, 'plan_discount');
  assert.equal(out.lines.at(-1).amount, -2.03);
});

test('no plan, no setting combination makes KidRide lose money on a ride', () => {
  const extreme = termsOf({ id: 'max', name: 'Max', discountPercent: 50, maxDiscountPerRide: 100, maxMiles: null, ridesPerWeek: 40 });
  for (const plan of [...settings.plans.map(termsOf), extreme]) {
    for (const service of ['pickup_only', 'pickup_and_dropoff', 'stay_with_child_and_dropoff']) {
      for (const miles of [0, 1, 3, 8, 15, 30, 60]) {
        for (const peak of [600, 480]) {
          const fare = fareFor(service, miles, miles * 3, 1, peak);
          const { amount } = subs.rideDiscount(plan, fare);
          const paid = fare.total - amount;
          const cardFee = fare.total * plan.cardFeePercent / 100 + plan.cardFeeFixed;
          const kept = paid - fare.driverEarnings - cardFee;
          assert.ok(kept >= plan.minProfitPerRide - 0.01, `${plan.id} ${service} ${miles}mi keeps ${kept}`);
          assert.ok(paid > fare.driverEarnings);
        }
      }
    }
  }
});

test('long trips over the plan mile limit get no discount', () => {
  const plan = termsOf(settings.plans.find((p) => p.id === 'school_week'));
  assert.deepEqual(subs.rideDiscount(plan, fareFor('pickup_only', 25, 40)), { amount: 0, reason: 'long_trip' });
  assert.ok(subs.rideDiscount({ ...plan, maxMiles: null }, fareFor('pickup_only', 25, 40)).amount <= plan.maxDiscountPerRide);
});

test('the week runs Monday to Monday in the pricing time zone', () => {
  // Sunday 23:30 New York is Monday 04:30 UTC: still the week that began Monday 9 Nov.
  const w = subs.weekWindow(new Date('2026-11-16T04:30:00Z'), 'America/New_York');
  assert.equal(w.startDay, '2026-11-09');
  assert.equal(w.start.toISOString(), '2026-11-09T05:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-11-16T05:00:00.000Z');
});

test('only active, paid-up plans count', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  assert.equal(subs.isLive({ status: 'active', current_period_end: '2026-12-13T00:00:00Z' }, now), true);
  assert.equal(subs.isLive({ status: 'past_due', current_period_end: '2026-12-13T00:00:00Z' }, now), false);
  assert.equal(subs.isLive({ status: 'active', current_period_end: '2026-11-01T00:00:00Z' }, now), false);
  assert.equal(subs.isLive(null, now), false);
});

test('without Stripe keys there is no plan and booking is priced as before', async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(await subs.liveTerms('parent-1'), null);
  const fare = fareFor('pickup_only', 5, 15);
  assert.deepEqual(await subs.priceForParent('parent-1', fare, new Date(), 'America/New_York'), { fare, discount: 0 });
  if (saved) process.env.STRIPE_SECRET_KEY = saved;
});
