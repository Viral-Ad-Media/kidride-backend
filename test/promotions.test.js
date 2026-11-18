// Promo codes and seasonal offers: what an admin can create, who they apply to,
// and what they take off a fare.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');

const NOW = Date.parse('2026-11-18T10:00:00Z');
const day = (offset) => new Date(NOW + offset * 86400000).toISOString();
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

// A small in-memory database: just the calls the promotion code makes.
const memoryDb = (tables) => ({
  tables,
  from(table) {
    const all = () => { tables[table] = tables[table] || []; return tables[table]; };
    const filters = [];
    let action = { kind: 'select' };
    let limit = Infinity;
    const matches = (row) => filters.every((filter) => filter(row));
    const run = () => {
      if (action.kind === 'insert') { all().push({ id: table + '-' + (all().length + 1), ...action.row }); return { data: null, count: null, error: null }; }
      const rows = all().filter(matches).slice(0, limit).map((row) => ({ ...row }));
      return { data: rows, count: rows.length, error: null };
    };
    const query = {
      select: () => query,
      order: () => query,
      limit: (count) => { limit = count; return query; },
      eq: (column, value) => { filters.push((row) => row[column] === value); return query; },
      in: (column, values) => { filters.push((row) => values.includes(row[column])); return query; },
      is: (column, value) => { filters.push((row) => (row[column] ?? null) === value); return query; },
      insert: (row) => { action = { kind: 'insert', row }; return query; },
      maybeSingle: async () => ({ data: run().data[0] || null, error: null }),
      then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
    };
    return query;
  }
});

const promo = (extra = {}) => ({
  id: 'promo-1', title: 'Summer 10% off', code: null, percent_off: 10, max_discount: null, audience: 'all',
  starts_at: day(-1), ends_at: day(30), max_uses_per_user: null, max_uses_total: null, active: true, created_at: day(-2), ...extra
});
// A $20 ride of which the driver earns $16: KidRide's share is $4.
const fare = { total: 20, currency: 'USD', driverEarnings: 16, lines: [{ key: 'base', label: 'Base fare', amount: 20 }] };

test('an admin creates a code or a seasonal offer, between 1% and 50%, for all, new or chosen parents', () => {
  const offer = promotions.parsePromotion({ title: '  Summer   10% off ', percentOff: 10, endsAt: day(30), active: true }, NOW);
  assert.equal(offer.error, undefined);
  assert.deepEqual(offer.promotion, { title: 'Summer 10% off', code: null, percent_off: 10, max_discount: null, audience: 'all', starts_at: new Date(NOW).toISOString(), ends_at: day(30), max_uses_per_user: null, max_uses_total: null, active: true });
  assert.deepEqual(offer.userIds, []);

  const code = promotions.parsePromotion({ title: 'Welcome', code: ' welcome-5 ', percentOff: '5', maxDiscount: '3.456', audience: 'new', maxUsesPerUser: 1, maxUsesTotal: '100' }, NOW);
  assert.equal(code.promotion.code, 'WELCOME5');
  assert.equal(code.promotion.max_discount, 3.46);
  assert.equal(code.promotion.audience, 'new');
  assert.equal(code.promotion.max_uses_per_user, 1);
  assert.equal(code.promotion.max_uses_total, 100);
  // Saved switched off unless the admin says otherwise.
  assert.equal(code.promotion.active, false);

  const chosen = promotions.parsePromotion({ title: 'For two families', percentOff: 7.5, audience: 'selected', userIds: [P1, P2, P1] }, NOW);
  assert.deepEqual(chosen.userIds, [P1, P2]);

  assert.match(promotions.parsePromotion({ title: 'x', percentOff: 10 }, NOW).error, /name/);
  assert.match(promotions.parsePromotion({ title: 'Too much', percentOff: 60 }, NOW).error, /between 1% and 50%/);
  assert.match(promotions.parsePromotion({ title: 'Nothing', percentOff: 0 }, NOW).error, /between 1% and 50%/);
  assert.match(promotions.parsePromotion({ title: 'Bad code', code: 'ab', percentOff: 10 }, NOW).error, /4 to 20/);
  assert.match(promotions.parsePromotion({ title: 'Bad code', code: 'SUMMER!!', percentOff: 10 }, NOW).error, /4 to 20/);
  assert.match(promotions.parsePromotion({ title: 'Nobody', percentOff: 10, audience: 'selected', userIds: [] }, NOW).error, /at least one parent/);
  assert.match(promotions.parsePromotion({ title: 'Not ids', percentOff: 10, audience: 'selected', userIds: ['someone'] }, NOW).error, /Choose the parents/);
  assert.match(promotions.parsePromotion({ title: 'Backwards', percentOff: 10, startsAt: day(5), endsAt: day(2) }, NOW).error, /after the start/);
  assert.match(promotions.parsePromotion({ title: 'Half a use', percentOff: 10, maxUsesPerUser: 0.5 }, NOW).error, /whole number/);
  assert.match(promotions.parsePromotion({ title: 'Who', percentOff: 10, audience: 'drivers' }, NOW).error, /who/);
});

test('a promotion is off, scheduled, live or ended', () => {
  assert.equal(promotions.promotionStatus(promo(), NOW), 'live');
  assert.equal(promotions.promotionStatus(promo({ active: false }), NOW), 'off');
  assert.equal(promotions.promotionStatus(promo({ starts_at: day(2) }), NOW), 'scheduled');
  assert.equal(promotions.promotionStatus(promo({ ends_at: day(-0.5) }), NOW), 'ended');
  assert.equal(promotions.promotionStatus(promo({ ends_at: null }), NOW), 'live');
});

test('the discount is the percentage, up to the limit per ride, and never more than KidRide\'s share', () => {
  assert.equal(promotions.discountFor(promo(), fare), 2);
  assert.equal(promotions.discountFor(promo({ percent_off: 7.5 }), fare), 1.5);
  assert.equal(promotions.discountFor(promo({ max_discount: 1.25 }), fare), 1.25);
  // 50% of $20 would be $10, but KidRide only keeps $4 of this fare: the driver's $16 is untouched.
  assert.equal(promotions.discountFor(promo({ percent_off: 50 }), fare), 4);
  const reduced = promotions.applyPromotion(fare, 2, promo());
  assert.equal(reduced.total, 18);
  assert.equal(reduced.driverEarnings, 16);
  assert.equal(reduced.promoDiscount, 2);
  assert.deepEqual(reduced.lines.at(-1), { key: 'promo', label: 'Summer 10% off (10% off)', amount: -2 });
  assert.equal(promotions.applyPromotion(fare, 0, promo()), fare);
});

test('a seasonal offer applies on its own to the parents it is for', async () => {
  const everyone = memoryDb({ promotions: [promo()] });
  assert.equal((await promotions.findFor(everyone, P1, { now: NOW })).promotion.id, 'promo-1');

  const chosen = memoryDb({ promotions: [promo({ audience: 'selected' })], promotion_users: [{ promotion_id: 'promo-1', parent_id: P1 }] });
  assert.equal((await promotions.findFor(chosen, P1, { now: NOW })).promotion.id, 'promo-1');
  assert.deepEqual(await promotions.findFor(chosen, P2, { now: NOW }), {});

  const firstRide = memoryDb({ promotions: [promo({ audience: 'new' })], rides: [{ id: 'r1', parent_id: P2, status: 'completed' }, { id: 'r2', parent_id: P1, status: 'cancelled' }] });
  assert.equal((await promotions.findFor(firstRide, P1, { now: NOW })).promotion.id, 'promo-1');
  assert.deepEqual(await promotions.findFor(firstRide, P2, { now: NOW }), {});

  // Switched off, not started or over: nothing applies. With two open, the larger one wins.
  assert.deepEqual(await promotions.findFor(memoryDb({ promotions: [promo({ active: false })] }), P1, { now: NOW }), {});
  assert.deepEqual(await promotions.findFor(memoryDb({ promotions: [promo({ starts_at: day(1) })] }), P1, { now: NOW }), {});
  assert.deepEqual(await promotions.findFor(memoryDb({ promotions: [promo({ ends_at: day(-1) })] }), P1, { now: NOW }), {});
  const two = memoryDb({ promotions: [promo({ id: 'small', percent_off: 5 }), promo({ id: 'big', percent_off: 10 })] });
  assert.equal((await promotions.findFor(two, P1, { now: NOW })).promotion.id, 'big');
  // A code is never applied on its own: it has to be typed.
  assert.deepEqual(await promotions.findFor(memoryDb({ promotions: [promo({ code: 'SUMMER10' })] }), P1, { now: NOW }), {});
});

test('a typed code is found whatever its case, and says why when it cannot be used', async () => {
  const db = memoryDb({ promotions: [promo({ code: 'SUMMER10' })] });
  assert.equal((await promotions.findFor(db, P1, { code: ' summer-10 ', now: NOW })).promotion.id, 'promo-1');
  assert.match((await promotions.findFor(db, P1, { code: 'WINTER10', now: NOW })).error, /not valid/);
  assert.match((await promotions.findFor(db, P1, { code: '!!', now: NOW })).error, /not valid/);
  assert.match((await promotions.findFor(memoryDb({ promotions: [promo({ code: 'SUMMER10', active: false })] }), P1, { code: 'SUMMER10', now: NOW })).error, /not active/);
  assert.match((await promotions.findFor(memoryDb({ promotions: [promo({ code: 'SUMMER10', ends_at: day(-1) })] }), P1, { code: 'SUMMER10', now: NOW })).error, /ended/);
  assert.match((await promotions.findFor(memoryDb({ promotions: [promo({ code: 'SUMMER10', audience: 'selected' })] }), P1, { code: 'SUMMER10', now: NOW })).error, /not available on your account/);
});

test('uses are limited per parent (cancelled rides do not count) and in total', async () => {
  const once = promo({ code: 'ONCE', max_uses_per_user: 1 });
  const used = memoryDb({ promotions: [once], promotion_redemptions: [{ promotion_id: 'promo-1', parent_id: P1, ride_id: 'r1' }], rides: [{ id: 'r1', parent_id: P1, status: 'completed' }] });
  assert.match((await promotions.findFor(used, P1, { code: 'ONCE', now: NOW })).error, /already used/);
  assert.equal((await promotions.findFor(used, P2, { code: 'ONCE', now: NOW })).promotion.id, 'promo-1');
  const cancelled = memoryDb({ promotions: [once], promotion_redemptions: [{ promotion_id: 'promo-1', parent_id: P1, ride_id: 'r1' }], rides: [{ id: 'r1', parent_id: P1, status: 'cancelled' }] });
  assert.equal((await promotions.findFor(cancelled, P1, { code: 'ONCE', now: NOW })).promotion.id, 'promo-1');

  const gone = memoryDb({ promotions: [promo({ code: 'FIRST2', max_uses_total: 2 })], promotion_redemptions: [{ promotion_id: 'promo-1', parent_id: P2, ride_id: 'r1' }, { promotion_id: 'promo-1', parent_id: P2, ride_id: 'r2' }] });
  assert.match((await promotions.findFor(gone, P1, { code: 'FIRST2', now: NOW })).error, /used up/);
});

const base = { currency: 'USD', quotes: { pickup_only: { ...fare, quoteToken: 'token-a' }, pickup_and_dropoff: { ...fare, total: 40, driverEarnings: 32, quoteToken: 'token-b' } } };

test('fares shown to the parent carry the promotion, with the same quote tokens', async () => {
  const shown = await promotions.decorateQuotes(memoryDb({ promotions: [promo()] }), P1, base, base, { now: NOW });
  assert.equal(shown.quotes.pickup_only.total, 18);
  assert.equal(shown.quotes.pickup_only.quoteToken, 'token-a');
  assert.equal(shown.quotes.pickup_and_dropoff.total, 36);
  assert.equal(shown.quotes.pickup_and_dropoff.quoteToken, 'token-b');
  assert.deepEqual(shown.promo, { id: 'promo-1', title: 'Summer 10% off', code: null, percentOff: 10, endsAt: day(30), applied: true });
  // Nothing about limits or other parents reaches the app.
  assert.doesNotMatch(JSON.stringify(shown.promo), /max|audience|uses/);

  // No promotion: the fares are returned exactly as they came.
  assert.equal(await promotions.decorateQuotes(memoryDb({ promotions: [] }), P1, base, base, { now: NOW }), base);
  // A code that cannot be used leaves the fares alone and says why.
  const bad = await promotions.decorateQuotes(memoryDb({ promotions: [] }), P1, base, base, { code: 'NOPE10', now: NOW });
  assert.equal(bad.quotes.pickup_only.total, 20);
  assert.match(bad.promoError, /not valid/);
  // A database problem never hides the fare.
  const broken = await promotions.decorateQuotes({ from: () => { throw Object.assign(new Error('no table'), { code: '42P01' }); } }, P1, base, base, { now: NOW });
  assert.equal(broken, base);
});

test('with a monthly plan too, each fare keeps whichever discount is larger', async () => {
  const withPlan = { ...base, plan: { name: 'Family' }, quotes: {
    pickup_only: { ...fare, total: 17, planDiscount: 3, quoteToken: 'token-a' },
    pickup_and_dropoff: { ...fare, total: 39, planDiscount: 1, driverEarnings: 32, quoteToken: 'token-b' }
  } };
  const shown = await promotions.decorateQuotes(memoryDb({ promotions: [promo()] }), P1, base, withPlan, { now: NOW });
  // Plan takes $3 off the first, the promotion only $2: the plan stays. On the second the promotion's $4 beats the plan's $1.
  assert.equal(shown.quotes.pickup_only.total, 17);
  assert.equal(shown.quotes.pickup_only.planDiscount, 3);
  assert.equal(shown.quotes.pickup_and_dropoff.total, 36);
  assert.equal(shown.quotes.pickup_and_dropoff.promoDiscount, 4);
  assert.equal(shown.plan.name, 'Family');
});

test('at booking the promotion is checked again, and a code that no longer works stops the booking', async () => {
  const db = memoryDb({ promotions: [promo({ code: 'SUMMER10' })] });
  const priced = await promotions.priceForParent(db, P1, fare, { code: 'summer10', now: NOW });
  assert.equal(priced.fare.total, 18);
  assert.equal(priced.discount, 2);
  assert.equal(priced.promotion.id, 'promo-1');
  // The plan already takes more off: the promotion steps aside.
  assert.deepEqual(await promotions.priceForParent(db, P1, fare, { code: 'summer10', planDiscount: 3, now: NOW }), { discount: 0 });
  // No code and no seasonal offer: nothing happens.
  assert.deepEqual(await promotions.priceForParent(db, P1, fare, { now: NOW }), { discount: 0 });
  await assert.rejects(promotions.priceForParent(db, P1, fare, { code: 'EXPIRED1', now: NOW }), { status: 409, code: 'promo_invalid' });
  // A seasonal offer that cannot be looked up never blocks a booking; a typed code does, so nobody pays more than shown.
  const broken = { from: () => { throw new Error('database down'); } };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await promotions.priceForParent(broken, P1, fare, { now: NOW }), { discount: 0 });
    await assert.rejects(promotions.priceForParent(broken, P1, fare, { code: 'SUMMER10', now: NOW }), { code: 'promo_unavailable' });
  } finally {
    console.error = quiet;
  }

  await promotions.recordRedemption(db, priced.promotion, P1, 'ride-1', priced.discount);
  assert.deepEqual(db.tables.promotion_redemptions.map((row) => [row.promotion_id, row.parent_id, row.ride_id, row.amount]), [['promo-1', P1, 'ride-1', 2]]);
});

test('the admin page shows how a promotion is doing', () => {
  const view = promotions.formatPromotion(promo({ code: 'SUMMER10', max_uses_total: 100 }), { uses: 12, saved: 23.456, users: [] }, NOW);
  assert.equal(view.status, 'live');
  assert.equal(view.uses, 12);
  assert.equal(view.saved, 23.46);
  assert.equal(view.percentOff, 10);
  assert.equal(view.maxUsesTotal, 100);
  assert.equal(view.code, 'SUMMER10');
});
