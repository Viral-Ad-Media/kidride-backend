// Promotions an admin creates: a promo code a parent types when booking, or a
// seasonal offer that applies on its own. Each takes a percentage off the fare
// for everyone, for new parents or for chosen parents, between two dates.
//
// A ride gets one discount: when a parent also has a monthly plan, the larger of
// the two is used. A discount never exceeds KidRide's own share of the fare, so
// the driver is always paid in full.
//
// The rules live here; routes/promotionRoutes.js serves them, and the fare
// quotes and the booking (routes/rideRoutes.js) ask what applies to a parent.
// Nothing here loads the database: callers pass it in.

const MIN_PERCENT = 1;
const MAX_PERCENT = 50;
const AUDIENCES = ['all', 'new', 'selected'];
const MAX_SELECTED_USERS = 500;
const NOT_READY = 'Promotions are not switched on yet.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const schemaMissing = (error) => ['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error?.code);
const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** A code as typed ("summer-10", " Summer10 "): capitals and digits only. */
const normalizeCode = (value) => String(value || '').toUpperCase().replace(/[\s-]/g, '');
const validCode = (code) => /^[A-Z0-9]{4,20}$/.test(code);

const optionalWhole = (value, label) => {
  if (value === undefined || value === null || value === '') return { value: null };
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return { error: `${label} must be a whole number of 1 or more, or left empty for no limit.` };
  return { value: number };
};

/** A promotion as the admin entered it, checked; or why it cannot be saved. */
const parsePromotion = (body, now = Date.now()) => {
  const title = clean(body?.title);
  if (title.length < 2) return { error: 'Give the promotion a name parents will see, such as "Summer 10% off".' };
  if (title.length > 80) return { error: 'Keep the name under 80 characters.' };

  // With a code the parent types it when booking; without one the offer applies on its own.
  const typed = normalizeCode(body.code);
  if (clean(body.code) && !validCode(typed)) return { error: 'A promo code is 4 to 20 letters and numbers, with no spaces.' };
  const code = typed || null;

  const percentOff = Number(body.percentOff);
  if (!Number.isFinite(percentOff) || percentOff < MIN_PERCENT || percentOff > MAX_PERCENT) return { error: `The discount must be between ${MIN_PERCENT}% and ${MAX_PERCENT}%.` };

  let maxDiscount = null;
  if (body.maxDiscount !== undefined && body.maxDiscount !== null && body.maxDiscount !== '') {
    maxDiscount = Number(body.maxDiscount);
    if (!Number.isFinite(maxDiscount) || maxDiscount <= 0) return { error: 'The most off one ride must be more than 0, or left empty for no limit.' };
    maxDiscount = round2(maxDiscount);
  }

  const audience = body.audience === undefined ? 'all' : body.audience;
  if (!AUDIENCES.includes(audience)) return { error: 'Choose who the promotion is for.' };
  let userIds = [];
  if (audience === 'selected') {
    if (!Array.isArray(body.userIds) || body.userIds.some((id) => typeof id !== 'string' || !UUID.test(id))) return { error: 'Choose the parents this promotion is for.' };
    userIds = [...new Set(body.userIds)];
    if (!userIds.length) return { error: 'Choose at least one parent, or make the promotion for all parents.' };
    if (userIds.length > MAX_SELECTED_USERS) return { error: `A promotion can be for up to ${MAX_SELECTED_USERS} chosen parents.` };
  }

  const startsAt = body.startsAt === undefined || body.startsAt === null || body.startsAt === '' ? new Date(now) : new Date(body.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { error: 'Choose a valid start date.' };
  let endsAt = null;
  if (body.endsAt !== undefined && body.endsAt !== null && body.endsAt !== '') {
    endsAt = new Date(body.endsAt);
    if (Number.isNaN(endsAt.getTime())) return { error: 'Choose a valid end date.' };
    if (endsAt.getTime() <= startsAt.getTime()) return { error: 'The end must be after the start.' };
  }

  const perUser = optionalWhole(body.maxUsesPerUser, 'Uses per parent');
  if (perUser.error) return { error: perUser.error };
  const total = optionalWhole(body.maxUsesTotal, 'Total uses');
  if (total.error) return { error: total.error };

  return {
    promotion: {
      title,
      code,
      percent_off: round2(percentOff),
      max_discount: maxDiscount,
      audience,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt ? endsAt.toISOString() : null,
      max_uses_per_user: perUser.value,
      max_uses_total: total.value,
      active: body.active === true
    },
    userIds
  };
};

/** off (switched off) | scheduled (on, not started) | live | ended. */
const promotionStatus = (promotion, now = Date.now()) => {
  if (!promotion.active) return 'off';
  if (Date.parse(promotion.starts_at) > now) return 'scheduled';
  if (promotion.ends_at && Date.parse(promotion.ends_at) <= now) return 'ended';
  return 'live';
};

const percentLabel = (promotion) => `${Number(promotion.percent_off)}%`;

/**
 * What a promotion takes off a fare: its percentage, up to its own limit per
 * ride and never more than KidRide's share of the fare (total minus what the driver earns).
 */
const discountFor = (promotion, fare) => {
  const total = Number(fare.total) || 0;
  let amount = total * Number(promotion.percent_off) / 100;
  if (promotion.max_discount !== null && promotion.max_discount !== undefined) amount = Math.min(amount, Number(promotion.max_discount));
  const kidrideShare = fare.driverEarnings === undefined || fare.driverEarnings === null ? total : total - Number(fare.driverEarnings);
  return round2(Math.max(0, Math.min(amount, kidrideShare)));
};

/** The fare with the promotion as its own line. driverEarnings stays the same. */
const applyPromotion = (fare, amount, promotion) => (amount > 0 ? {
  ...fare,
  total: round2(fare.total - amount),
  promoDiscount: amount,
  lines: [...(fare.lines || []), { key: 'promo', label: `${promotion.title} (${percentLabel(promotion)} off)`, amount: -amount }]
} : fare);

/** A promotion as a parent sees it: no limits, no audience, nothing about other parents. */
const publicPromotion = (promotion) => ({
  id: promotion.id,
  title: promotion.title,
  code: promotion.code || null,
  percentOff: Number(promotion.percent_off),
  endsAt: promotion.ends_at || null
});

// ---- Who may use a promotion ----

const WHY_NOT = {
  off: 'That promo code is not active.',
  scheduled: 'That promo code has not started yet.',
  ended: 'That promo code has ended.',
  audience: 'That promo code is not available on your account.',
  new: 'That promo code is for a first ride only.',
  per_user: 'You have already used that promo code.',
  total: 'That promo code has been used up.'
};

/** Rides of this parent that used the promotion and were not cancelled. */
const usedByParent = async (db, promotionId, parentId) => {
  const { data, error } = await db.from('promotion_redemptions').select('ride_id').eq('promotion_id', promotionId).eq('parent_id', parentId).limit(500);
  if (error) throw error;
  const rideIds = (data || []).map((row) => row.ride_id);
  if (!rideIds.length) return 0;
  const { data: rides, error: rideError } = await db.from('rides').select('id, status').in('id', rideIds);
  if (rideError) throw rideError;
  return (rides || []).filter((ride) => ride.status !== 'cancelled').length;
};

/** null when this parent may use the promotion now; otherwise which rule stops them (a key of WHY_NOT). */
const blockedBy = async (db, promotion, parentId, now = Date.now()) => {
  const status = promotionStatus(promotion, now);
  if (status !== 'live') return status;
  if (promotion.audience === 'selected') {
    const { data, error } = await db.from('promotion_users').select('parent_id').eq('promotion_id', promotion.id).eq('parent_id', parentId).maybeSingle();
    if (error) throw error;
    if (!data) return 'audience';
  }
  if (promotion.audience === 'new') {
    const { count, error } = await db.from('rides').select('id', { count: 'exact', head: true }).eq('parent_id', parentId).eq('status', 'completed');
    if (error) throw error;
    if (count > 0) return 'new';
  }
  if (promotion.max_uses_per_user && (await usedByParent(db, promotion.id, parentId)) >= promotion.max_uses_per_user) return 'per_user';
  if (promotion.max_uses_total) {
    const { count, error } = await db.from('promotion_redemptions').select('id', { count: 'exact', head: true }).eq('promotion_id', promotion.id);
    if (error) throw error;
    if (count >= promotion.max_uses_total) return 'total';
  }
  return null;
};

/** Offers that apply on their own (no code) and are switched on, whatever their dates. */
const loadAutomatic = async (db) => {
  const { data, error } = await db.from('promotions').select('*').eq('active', true).is('code', null).limit(100);
  if (error) throw error;
  return data || [];
};

/**
 * The promotion for this parent's booking: the code they typed, or else the
 * best seasonal offer open to them. Returns { promotion } (or {} for none), or
 * { error } with the reason a typed code cannot be used.
 */
const findFor = async (db, parentId, { code, now = Date.now() } = {}) => {
  const typed = normalizeCode(code);
  if (typed) {
    if (!validCode(typed)) return { error: 'That promo code is not valid.' };
    const { data, error } = await db.from('promotions').select('*').eq('code', typed).maybeSingle();
    if (error) throw error;
    if (!data) return { error: 'That promo code is not valid.' };
    const blocked = await blockedBy(db, data, parentId, now);
    return blocked ? { error: WHY_NOT[blocked] } : { promotion: data };
  }
  const open = [];
  for (const offer of await loadAutomatic(db)) {
    if (!(await blockedBy(db, offer, parentId, now))) open.push(offer);
  }
  open.sort((a, b) => Number(b.percent_off) - Number(a.percent_off));
  return open.length ? { promotion: open[0] } : {};
};

/**
 * Adds the promotion to every service quote (display only; booking re-checks).
 * `base` holds the fares before any discount, `withPlan` the same after the
 * monthly plan. Each service keeps whichever discount is larger.
 * A typed code that cannot be used comes back as `promoError`.
 */
const decorateQuotes = async (db, parentId, base, withPlan, { code, now = Date.now() } = {}) => {
  let found;
  try {
    found = await findFor(db, parentId, { code, now });
  } catch (error) {
    // Promotions must never stop a parent seeing a fare.
    if (!schemaMissing(error)) console.error('Promotion lookup failed', error.message);
    return normalizeCode(code) ? { ...withPlan, promoError: 'Promo codes are not available right now.' } : withPlan;
  }
  if (found.error) return { ...withPlan, promoError: found.error };
  if (!found.promotion) return withPlan;
  const quotes = {};
  let applied = false;
  for (const [type, quote] of Object.entries(base.quotes)) {
    const planned = withPlan.quotes[type];
    const amount = discountFor(found.promotion, quote);
    if (amount > (Number(planned.planDiscount) || 0)) {
      quotes[type] = { ...applyPromotion(quote, amount, found.promotion), quoteToken: quote.quoteToken };
      applied = true;
    } else {
      quotes[type] = planned;
    }
  }
  return { ...withPlan, quotes, promo: { ...publicPromotion(found.promotion), applied } };
};

/**
 * Prices one ride with the promotion that applies, for the booking itself.
 * `fare` is the fare before any discount and `planDiscount` what the monthly
 * plan would take off. Returns { fare, discount, promotion } when the promotion
 * is the better deal, else { discount: 0 }. A typed code that cannot be used
 * stops the booking (409) so nobody pays more than they were shown.
 */
const priceForParent = async (db, parentId, fare, { code, planDiscount = 0, now = Date.now() } = {}) => {
  const typed = normalizeCode(code);
  let found;
  try {
    found = await findFor(db, parentId, { code, now });
  } catch (error) {
    if (typed) throw fail(schemaMissing(error) ? 503 : 502, 'Promo codes are not available right now. Remove the code to book at the normal fare.', 'promo_unavailable');
    if (!schemaMissing(error)) console.error('Promotion lookup failed', error.message);
    return { discount: 0 };
  }
  if (found.error) throw fail(409, `${found.error} Remove the code to book at the normal fare.`, 'promo_invalid');
  if (!found.promotion) return { discount: 0 };
  const amount = discountFor(found.promotion, fare);
  if (amount <= 0 || amount <= planDiscount) return { discount: 0 };
  return { fare: applyPromotion(fare, amount, found.promotion), discount: amount, promotion: found.promotion };
};

/** Notes that a ride used a promotion, so the limits count it. */
const recordRedemption = async (db, promotion, parentId, rideId, amount) => {
  const { error } = await db.from('promotion_redemptions').insert({ promotion_id: promotion.id, parent_id: parentId, ride_id: rideId, amount: round2(amount) });
  if (error) throw error;
};

/** A promotion as the admin page shows it. */
const formatPromotion = (promotion, { uses = 0, saved = 0, users = [] } = {}, now = Date.now()) => ({
  id: promotion.id,
  title: promotion.title,
  code: promotion.code || null,
  percentOff: Number(promotion.percent_off),
  maxDiscount: promotion.max_discount === null || promotion.max_discount === undefined ? null : Number(promotion.max_discount),
  audience: promotion.audience,
  users,
  startsAt: promotion.starts_at,
  endsAt: promotion.ends_at || null,
  maxUsesPerUser: promotion.max_uses_per_user || null,
  maxUsesTotal: promotion.max_uses_total || null,
  active: !!promotion.active,
  status: promotionStatus(promotion, now),
  uses,
  saved: round2(saved),
  createdAt: promotion.created_at
});

module.exports = {
  MIN_PERCENT,
  MAX_PERCENT,
  AUDIENCES,
  NOT_READY,
  WHY_NOT,
  schemaMissing,
  normalizeCode,
  parsePromotion,
  promotionStatus,
  discountFor,
  applyPromotion,
  publicPromotion,
  blockedBy,
  findFor,
  decorateQuotes,
  priceForParent,
  recordRedemption,
  formatPromotion
};
