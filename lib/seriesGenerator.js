// Creates the individual scheduled rides of active repeating bookings, up to
// series.GENERATE_DAYS ahead. Safe to run often and from several places (the
// cron, a parent's page load): (series_id, series_date) is unique, so a day is
// created once and a day the parent cancelled is never created again.

const { supabaseAdmin } = require('../config/supabase');
const { computeFare } = require('./pricing');
const { loadPricing } = require('./pricingSettings');
const { generateTripCode, generateSafeWord } = require('./security');
const series = require('./series');
const subscriptions = require('./subscriptions');

const rideFor = (row, day, settings) => {
  const fare = computeFare(settings, {
    serviceType: row.service_type,
    miles: Number(row.route_miles) || 0,
    minutes: Number(row.route_minutes) || 0,
    stayMinutes: row.stay_minutes,
    pickupTime: day.pickupTime,
    distanceSource: row.distance_source,
    extraChildren: row.child_ids.length - 1
  });
  return {
    parent_id: row.parent_id,
    child_id: row.child_ids[0],
    child_ids: row.child_ids,
    pickup_location: row.pickup_location,
    dropoff_location: row.dropoff_location,
    pickup_coords: row.pickup_coords,
    dropoff_coords: row.dropoff_coords,
    pickup_time: day.pickupTime.toISOString(),
    status: 'searching_driver',
    price: fare.total,
    currency: fare.currency,
    driver_earnings: fare.driverEarnings,
    fare_breakdown: { lines: fare.lines, miles: fare.miles, minutes: fare.minutes, stayMinutes: fare.stayMinutes, distanceSource: fare.distanceSource },
    trip_code: generateTripCode(),
    safe_word: generateSafeWord(),
    service_type: row.service_type,
    dispatch_state: 'open',
    is_scheduled: true,
    series_id: row.id,
    series_date: day.date
  };
};

// Monthly plan discount for each new ride. School-week rides count toward the
// plan's weekly cap like any other ride, in date order.
const withPlanDiscounts = async (row, days, settings, termsCache) => {
  const { data: existing, error } = await supabaseAdmin.from('rides').select('series_date').eq('series_id', row.id).in('series_date', days.map((day) => day.date));
  if (error) throw error;
  const have = new Set((existing || []).map((ride) => ride.series_date));
  const fresh = days.filter((day) => !have.has(day.date));
  if (!termsCache.has(row.parent_id)) termsCache.set(row.parent_id, await subscriptions.liveTerms(row.parent_id));
  const terms = termsCache.get(row.parent_id);
  const givenPerWeek = new Map();
  const out = [];
  for (const day of fresh) {
    const ride = rideFor(row, day, settings);
    if (terms) {
      const week = subscriptions.weekWindow(day.pickupTime, settings.timezone).startDay;
      const fare = { total: ride.price, driverEarnings: ride.driver_earnings, miles: ride.fare_breakdown.miles, lines: ride.fare_breakdown.lines };
      const priced = await subscriptions.priceForParent(row.parent_id, fare, day.pickupTime, settings.timezone, { terms, extraUsed: givenPerWeek.get(week) || 0 });
      if (priced.discount > 0) {
        givenPerWeek.set(week, (givenPerWeek.get(week) || 0) + 1);
        ride.price = priced.fare.total;
        ride.fare_breakdown = { ...ride.fare_breakdown, lines: priced.fare.lines };
        ride.subscription_discount = priced.discount;
      }
    }
    out.push(ride);
  }
  return out;
};

/** Creates due rides for the given series rows. Returns how many were created. */
const generateForRows = async (rows, now = new Date()) => {
  if (!rows.length) return 0;
  const settings = await loadPricing();
  const termsCache = new Map();
  let created = 0;
  for (const row of rows) {
    // Past its last day: the series is over.
    if (row.end_date < series.localDate(now, row.time_zone)) {
      await supabaseAdmin.from('ride_series').update({ status: 'ended', updated_at: now.toISOString() }).eq('id', row.id).eq('status', 'active');
      continue;
    }
    const days = series.occurrences(series.planOf(row), now);
    if (!days.length) continue;
    const rides = await withPlanDiscounts(row, days, settings, termsCache);
    if (!rides.length) continue;
    const { data, error } = await supabaseAdmin.from('rides')
      .upsert(rides, { onConflict: 'series_id,series_date', ignoreDuplicates: true })
      .select('id');
    if (error) throw error;
    created += (data || []).length;
  }
  return created;
};

const activeSeries = (parentId) => {
  let query = supabaseAdmin.from('ride_series').select('*').eq('status', 'active').limit(200);
  if (parentId) query = query.eq('parent_id', parentId);
  return query;
};

const generateForParent = async (parentId, now = new Date()) => {
  const { data, error } = await activeSeries(parentId);
  if (error) throw error;
  return generateForRows(data || [], now);
};

/** Every parent's series (cron). */
const generateAll = async (now = new Date()) => {
  const { data, error } = await activeSeries(null);
  if (error) throw error;
  return generateForRows(data || [], now);
};

module.exports = { generateForParent, generateAll, generateForRows, rideFor };
