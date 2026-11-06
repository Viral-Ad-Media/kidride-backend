// Creates the individual scheduled rides of active repeating bookings, up to
// series.GENERATE_DAYS ahead. Safe to run often and from several places (the
// cron, a parent's page load): (series_id, series_date) is unique, so a day is
// created once and a day the parent cancelled is never created again.

const { supabaseAdmin } = require('../config/supabase');
const { computeFare } = require('./pricing');
const { loadPricing } = require('./pricingSettings');
const { generateTripCode, generateSafeWord } = require('./security');
const series = require('./series');

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

/** Creates due rides for the given series rows. Returns how many were created. */
const generateForRows = async (rows, now = new Date()) => {
  if (!rows.length) return 0;
  const settings = await loadPricing();
  let created = 0;
  for (const row of rows) {
    // Past its last day: the series is over.
    if (row.end_date < series.localDate(now, row.time_zone)) {
      await supabaseAdmin.from('ride_series').update({ status: 'ended', updated_at: now.toISOString() }).eq('id', row.id).eq('status', 'active');
      continue;
    }
    const days = series.occurrences(series.planOf(row), now);
    if (!days.length) continue;
    const { data, error } = await supabaseAdmin.from('rides')
      .upsert(days.map((day) => rideFor(row, day, settings)), { onConflict: 'series_id,series_date', ignoreDuplicates: true })
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
