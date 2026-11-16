// Monthly family plans (Stripe Billing).
//
// A parent pays a monthly fee and gets a percentage off up to `ridesPerWeek`
// rides a week (Monday to Sunday in the pricing time zone). Rides past the cap,
// or longer than the plan's mile limit, are charged the normal fare.
//
// The discount only ever comes out of KidRide's share: the driver's earnings on
// the ride are unchanged, and each discount is capped so KidRide still keeps at
// least `minProfitPerRide` after the card fee. A plan can therefore never make
// a ride lose money, whatever the admin sets.
//
// Plans live in the admin-edited subscription_settings row. A parent's terms are
// copied onto their subscription when they join, so later edits only affect new
// subscribers. Everything is inert until payments are switched on.

const { round2 } = require('./pricing');
const series = require('./series');
const stripe = require('./stripeApi');

const db = () => require('../config/supabase').supabaseAdmin;
const payments = () => require('./payments');
const fail = (message, status = 400, code) => Object.assign(new Error(message), { status, code });

const DEFAULT_SETTINGS = Object.freeze({
  // KidRide keeps at least this much per discounted ride after the card fee.
  minProfitPerRide: 1.5,
  // Card fee estimate used for that check (Stripe US list price).
  cardFeePercent: 2.9,
  cardFeeFixed: 0.3,
  plans: [
    { id: 'starter', name: 'Starter', monthlyPrice: 4.99, discountPercent: 5, ridesPerWeek: 4, maxDiscountPerRide: 2, maxMiles: 15, active: true },
    { id: 'school_week', name: 'School week', monthlyPrice: 9.99, discountPercent: 10, ridesPerWeek: 10, maxDiscountPerRide: 4, maxMiles: 20, active: true },
    { id: 'family_plus', name: 'Family plus', monthlyPrice: 19.99, discountPercent: 15, ridesPerWeek: 15, maxDiscountPerRide: 5, maxMiles: 20, active: true }
  ]
});

const MAX_PLANS = 6;
const num = (value, name, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(`${name} must be a number from ${min} to ${max}`);
  return value;
};

const normalizePlan = (raw, index) => {
  const label = `Plan ${index + 1}`;
  if (!raw || typeof raw !== 'object') throw fail(`${label} is not valid`);
  const id = String(raw.id || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,32}$/.test(id)) throw fail(`${label}: id must be 2-32 lowercase letters, numbers or _`);
  const name = String(raw.name || '').trim();
  if (!name || name.length > 40) throw fail(`${label}: name must be 1-40 characters`);
  const ridesPerWeek = num(raw.ridesPerWeek, `${name}: rides per week`, 1, 40);
  if (!Number.isInteger(ridesPerWeek)) throw fail(`${name}: rides per week must be a whole number`);
  return {
    id,
    name,
    monthlyPrice: round2(num(raw.monthlyPrice, `${name}: monthly price`, 0.5, 1000)),
    discountPercent: round2(num(raw.discountPercent, `${name}: discount`, 0, 50)),
    ridesPerWeek,
    maxDiscountPerRide: round2(num(raw.maxDiscountPerRide, `${name}: max discount per ride`, 0, 100)),
    maxMiles: raw.maxMiles === null || raw.maxMiles === undefined || raw.maxMiles === '' ? null : round2(num(raw.maxMiles, `${name}: max miles`, 1, 500)),
    active: raw.active !== false
  };
};

const normalizeSettings = (input = {}) => {
  const raw = { ...DEFAULT_SETTINGS, ...input };
  if (!Array.isArray(raw.plans) || raw.plans.length > MAX_PLANS) throw fail(`Up to ${MAX_PLANS} plans`);
  const plans = raw.plans.map(normalizePlan);
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length) throw fail('Each plan needs its own id');
  return {
    minProfitPerRide: round2(num(raw.minProfitPerRide, 'Minimum profit per ride', 0, 100)),
    cardFeePercent: round2(num(raw.cardFeePercent, 'Card fee percent', 0, 10)),
    cardFeeFixed: round2(num(raw.cardFeeFixed, 'Card fee fixed', 0, 5)),
    plans
  };
};

// Created on first use so this module can be required without database settings (tests).
let storeInstance = null;
const store = () => (storeInstance ??= require('./settingsStore').createSettingsStore('subscription_settings', DEFAULT_SETTINGS, normalizeSettings, 'Plans'));

// ---------- pure pricing ----------

/**
 * The discount one ride gets under `terms` (a plan plus the profit guard).
 * fare: computeFare() output. Returns { amount, reason } where reason explains a zero.
 */
const rideDiscount = (terms, fare) => {
  if (terms.maxMiles && fare.miles > terms.maxMiles) return { amount: 0, reason: 'long_trip' };
  const wanted = Math.min(fare.total * terms.discountPercent / 100, terms.maxDiscountPerRide);
  const kidrideShare = fare.total - (Number(fare.driverEarnings) || 0);
  const cardFee = fare.total * terms.cardFeePercent / 100 + terms.cardFeeFixed;
  const room = kidrideShare - cardFee - terms.minProfitPerRide;
  const amount = round2(Math.max(0, Math.min(wanted, room)));
  return { amount, reason: amount > 0 ? null : 'no_margin' };
};

/** The fare with the plan discount as its own line. driverEarnings stays the same. */
const applyDiscount = (fare, amount, terms) => (amount > 0 ? {
  ...fare,
  total: round2(fare.total - amount),
  planDiscount: amount,
  lines: [...fare.lines, { key: 'plan_discount', label: `${terms.name} plan (${terms.discountPercent}% off)`, amount: -amount }]
} : fare);

/** Monday 00:00 to the next Monday 00:00 (local, in `tz`) around `date`. */
const weekWindow = (date, tz) => {
  const today = series.localDate(date, tz);
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const startDay = monday.toISOString().slice(0, 10);
  const next = new Date(monday.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  return { start: series.zonedTime(startDay, '00:00', tz), end: series.zonedTime(next, '00:00', tz), startDay };
};

// ---------- stored state ----------

const LIVE = ['active', 'trialing'];
const isLive = (row, now = new Date()) => !!row && LIVE.includes(row.status)
  && (!row.current_period_end || new Date(row.current_period_end).getTime() > now.getTime() - 3 * 86400000);

const loadSubscription = async (parentId) => {
  const { data, error } = await db().from('parent_subscriptions').select('*').eq('parent_id', parentId).maybeSingle();
  if (error) throw error;
  return data;
};

/** The parent's plan terms when they have a paid-up plan, else null. Never throws (booking must not break). */
const liveTerms = async (parentId, now = new Date()) => {
  if (!payments().enabled()) return null;
  try {
    const row = await loadSubscription(parentId);
    if (!isLive(row, now)) return null;
    const settings = await store().load();
    return { ...row.terms, minProfitPerRide: settings.minProfitPerRide, cardFeePercent: settings.cardFeePercent, cardFeeFixed: settings.cardFeeFixed };
  } catch (error) {
    console.error('Plan lookup failed', error.message);
    return null;
  }
};

/** Discounted rides the parent already has in the week of `at` (cancelled ones free the slot). */
const usedInWeek = async (parentId, at, tz) => {
  const { start, end } = weekWindow(at, tz);
  const { count, error } = await db().from('rides').select('id', { count: 'exact', head: true })
    .eq('parent_id', parentId).gt('subscription_discount', 0).neq('status', 'cancelled')
    // Rides booked for now have no pickup_time; they count by when they were booked.
    .or(`and(pickup_time.gte.${start.toISOString()},pickup_time.lt.${end.toISOString()}),and(pickup_time.is.null,created_at.gte.${start.toISOString()},created_at.lt.${end.toISOString()})`);
  if (error) throw error;
  return count || 0;
};

/**
 * Prices one ride for a parent: returns the fare with the plan discount applied
 * when they have a plan, the trip qualifies and the week's cap is not reached.
 * `extraUsed` counts discounts already given in the same batch (recurring rides).
 */
const priceForParent = async (parentId, fare, at, tz, { terms, extraUsed = 0 } = {}) => {
  const plan = terms === undefined ? await liveTerms(parentId) : terms;
  if (!plan) return { fare, discount: 0 };
  try {
    const used = (await usedInWeek(parentId, at, tz)) + extraUsed;
    if (used >= plan.ridesPerWeek) return { fare, discount: 0, reason: 'weekly_cap' };
    const { amount, reason } = rideDiscount(plan, fare);
    return { fare: applyDiscount(fare, amount, plan), discount: amount, reason };
  } catch (error) {
    console.error('Plan discount failed', error.message);
    return { fare, discount: 0 };
  }
};

/** Adds the plan discount to every service quote (display only; booking re-checks). */
const decorateQuotes = async (parentId, result, at, tz) => {
  const terms = await liveTerms(parentId);
  if (!terms) return result;
  let used = 0;
  try { used = await usedInWeek(parentId, at, tz); } catch { return result; }
  const left = Math.max(0, terms.ridesPerWeek - used);
  const quotes = {};
  for (const [type, quote] of Object.entries(result.quotes)) {
    const amount = left > 0 ? rideDiscount(terms, quote).amount : 0;
    quotes[type] = { ...applyDiscount(quote, amount, terms), quoteToken: quote.quoteToken };
  }
  return { ...result, quotes, plan: { name: terms.name, ridesPerWeek: terms.ridesPerWeek, ridesLeftThisWeek: left } };
};

// ---------- what the parent sees ----------

const publicPlan = (plan, currency) => ({
  id: plan.id, name: plan.name, monthlyPrice: plan.monthlyPrice, currency,
  discountPercent: plan.discountPercent, ridesPerWeek: plan.ridesPerWeek, maxDiscountPerRide: plan.maxDiscountPerRide, maxMiles: plan.maxMiles
});

const publicSubscription = (row) => (row ? {
  planId: row.plan_id,
  status: row.status,
  terms: row.terms,
  currentPeriodEnd: row.current_period_end,
  cancelAtPeriodEnd: !!row.cancel_at_period_end,
  live: isLive(row)
} : null);

const overview = async (parentId, pricing) => {
  if (!payments().enabled()) return { enabled: false };
  const [settings, row] = await Promise.all([store().load(), loadSubscription(parentId)]);
  const subscription = publicSubscription(row);
  let usage = null;
  if (subscription?.live) usage = { used: await usedInWeek(parentId, new Date(), pricing.timezone), cap: row.terms.ridesPerWeek };
  return { enabled: true, currency: pricing.currency, plans: settings.plans.filter((p) => p.active).map((p) => publicPlan(p, pricing.currency)), subscription, usage };
};

// ---------- Stripe Billing ----------

const webAppUrl = () => (process.env.FRONTEND_URLS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)[0] || 'http://localhost:3001';

/** Starts Stripe Checkout for a plan; the subscription is saved when Stripe confirms it (webhook). */
const startCheckout = async (user, planId, pricing) => {
  if (!payments().enabled()) throw fail('Payments are not switched on yet', 409, 'payments_off');
  const settings = await store().load();
  const plan = settings.plans.find((p) => p.id === planId && p.active);
  if (!plan) throw fail('Choose a plan');
  const current = await loadSubscription(user.id);
  if (isLive(current)) throw fail('You already have a plan. Cancel it first to change plans.', 409);
  const customer = (await payments().ensureCustomer(user)).stripe_customer_id;
  const terms = { id: plan.id, name: plan.name, monthlyPrice: plan.monthlyPrice, currency: pricing.currency, discountPercent: plan.discountPercent, ridesPerWeek: plan.ridesPerWeek, maxDiscountPerRide: plan.maxDiscountPerRide, maxMiles: plan.maxMiles };
  const metadata = { parent_id: user.id, plan_id: plan.id };
  const session = await stripe.post('/checkout/sessions', {
    mode: 'subscription',
    customer,
    client_reference_id: user.id,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: pricing.currency.toLowerCase(),
        unit_amount: stripe.toMinor(plan.monthlyPrice, pricing.currency),
        recurring: { interval: 'month' },
        product_data: { name: `KidRide ${plan.name} plan`, description: `${plan.discountPercent}% off up to ${plan.ridesPerWeek} rides a week` }
      }
    }],
    metadata,
    subscription_data: { metadata },
    success_url: `${webAppUrl()}/#/plans?checkout=done`,
    cancel_url: `${webAppUrl()}/#/plans?checkout=cancelled`
  }, { idempotencyKey: `plan-checkout-${user.id}-${plan.id}-${Math.floor(Date.now() / 60000)}` });
  const { error } = await db().from('parent_subscriptions').upsert({
    parent_id: user.id, plan_id: plan.id, terms, status: current && isLive(current) ? current.status : 'incomplete',
    stripe_checkout_session_id: session.id, updated_at: new Date().toISOString()
  }, { onConflict: 'parent_id' });
  if (error) throw error;
  return { url: session.url };
};

const STATUS = new Set(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']);
const isoFromUnix = (value) => (value ? new Date(value * 1000).toISOString() : null);

/** Copies a Stripe subscription object onto the parent's row. */
const syncSubscription = async (sub) => {
  const parentId = sub.metadata?.parent_id;
  if (!parentId) return null;
  const item = sub.items?.data?.[0] || {};
  const values = {
    parent_id: parentId,
    stripe_subscription_id: sub.id,
    status: STATUS.has(sub.status) ? sub.status : 'incomplete',
    cancel_at_period_end: !!sub.cancel_at_period_end,
    current_period_start: isoFromUnix(sub.current_period_start ?? item.current_period_start),
    current_period_end: isoFromUnix(sub.current_period_end ?? item.current_period_end),
    updated_at: new Date().toISOString()
  };
  const { data: existing } = await db().from('parent_subscriptions').select('stripe_subscription_id').eq('parent_id', parentId).maybeSingle();
  // An old, replaced subscription must not overwrite the current one.
  if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== sub.id && !LIVE.includes(sub.status)) return null;
  const { data, error } = await db().from('parent_subscriptions').upsert(values, { onConflict: 'parent_id' }).select('*').single();
  if (error) throw error;
  return data;
};

const loadLive = async (parentId) => {
  const row = await loadSubscription(parentId);
  if (!row?.stripe_subscription_id || !isLive(row)) throw fail('You do not have an active plan', 409);
  return row;
};

/** Stops renewal at the end of the paid month; the discount stays until then. */
const cancelAtPeriodEnd = async (parentId, cancel = true) => {
  const row = await loadLive(parentId);
  const sub = await stripe.post(`/subscriptions/${row.stripe_subscription_id}`, { cancel_at_period_end: cancel ? 'true' : 'false' });
  return publicSubscription(await syncSubscription(sub));
};

/** Ends a plan now (account deletion, admin). */
const cancelNow = async (parentId) => {
  const row = await loadSubscription(parentId);
  if (!row?.stripe_subscription_id || ['canceled', 'incomplete_expired'].includes(row.status)) return null;
  const ended = await stripe.del(`/subscriptions/${row.stripe_subscription_id}`);
  return syncSubscription(ended);
};

/** Webhook events for plans. Returns true when the event was a plan event. */
const handleEvent = async (event) => {
  const object = event.data?.object || {};
  if (event.type.startsWith('customer.subscription.')) { await syncSubscription(object); return true; }
  if (event.type === 'checkout.session.completed' && object.mode === 'subscription' && object.subscription) {
    await syncSubscription(await stripe.get(`/subscriptions/${object.subscription}`));
    return true;
  }
  if (event.type === 'invoice.payment_failed' && object.subscription) {
    await syncSubscription(await stripe.get(`/subscriptions/${object.subscription}`));
    return true;
  }
  return false;
};

// ---------- admin ----------

const subscriberSummary = async () => {
  const { data, error } = await db().from('parent_subscriptions').select('plan_id, status, terms');
  if (error) throw error;
  const counts = {};
  let monthly = 0;
  for (const row of data || []) {
    if (!isLive(row)) continue;
    counts[row.plan_id] = (counts[row.plan_id] || 0) + 1;
    monthly += Number(row.terms?.monthlyPrice) || 0;
  }
  return { active: counts, monthlyRevenue: round2(monthly) };
};

module.exports = {
  DEFAULT_SETTINGS, normalizeSettings, loadPlans: () => store().load(), savePlans: (input, adminId) => store().save(input, adminId), plansUpdatedAt: () => store().updatedAt(),
  rideDiscount, applyDiscount, weekWindow, isLive,
  liveTerms, usedInWeek, priceForParent, decorateQuotes,
  overview, startCheckout, cancelAtPeriodEnd, cancelNow, syncSubscription, handleEvent, subscriberSummary
};
