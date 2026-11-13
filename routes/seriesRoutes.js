const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { RIDE_SELECT, fetchRideRows, formatRide, updateRideRow } = require('../lib/repository');
const { sendError } = require('../lib/http');
const { parsePlaceCoords, isSamePlace, SAME_PLACE_MESSAGE } = require('../lib/security');
const { SERVICE_TYPES, MAX_CHILDREN_PER_RIDE, computeFare, cancellationFee } = require('../lib/pricing');
const { loadPricing } = require('../lib/pricingSettings');
const { tripMetrics } = require('../lib/routeMetrics');
const { notifyRideEvent } = require('../lib/notifications');
const scheduling = require('../lib/scheduling');
const payments = require('../lib/payments');
const series = require('../lib/series');
const { generateForParent } = require('../lib/seriesGenerator');

// Recurring school-week bookings: /api/ride-series
const router = express.Router();
const safely = async (work, label) => { try { return await work(); } catch (error) { console.error(label, error); return undefined; } };
const seriesLimiter = createRateLimiter({
  windowMs: 60 * 1000, max: 10, message: 'Too many booking changes. Please wait and try again.', keyPrefix: 'ride-series',
  keyGenerator: (req) => (req.user && req.user.id ? `user:${req.user.id}` : null)
});

const parentOnly = (req, res, next) => (req.user.role === 'parent' ? next() : res.status(403).json({ message: 'Only parents can book repeating rides' }));

// Trip part of a request (children, route, service). Returns { error } or fields.
const normalizeTrip = (req) => {
  const body = req.body || {};
  const raw = Array.isArray(body.childIds) ? body.childIds : [];
  const childIds = [...new Set(raw)];
  const own = new Set((req.user.children || []).map((child) => child.id));
  if (!raw.length || raw.length > MAX_CHILDREN_PER_RIDE || childIds.length !== raw.length) return { error: `Choose 1 to ${MAX_CHILDREN_PER_RIDE} children` };
  if (!childIds.every((id) => own.has(id))) return { error: 'Select children from your account', status: 403 };
  const pickup = typeof body.pickup === 'string' ? body.pickup.trim() : '';
  const dropoff = typeof body.dropoff === 'string' ? body.dropoff.trim() : '';
  if (!pickup || !dropoff) return { error: 'Enter the pickup and drop-off first.' };
  if (isSamePlace(pickup, dropoff, parsePlaceCoords(body.pickupCoords), parsePlaceCoords(body.dropoffCoords))) return { error: SAME_PLACE_MESSAGE };
  const serviceType = body.serviceType || 'pickup_only';
  if (!SERVICE_TYPES.includes(serviceType)) return { error: 'Invalid service type' };
  const stayMinutes = serviceType === 'stay_with_child_and_dropoff' ? (body.stayMinutes ?? 60) : 0;
  if (!Number.isInteger(stayMinutes) || stayMinutes < 0 || stayMinutes > 480) return { error: 'Stay time must be whole minutes, up to 8 hours' };
  return { childIds, pickup, dropoff, serviceType, stayMinutes, pickupCoords: parsePlaceCoords(body.pickupCoords), dropoffCoords: parsePlaceCoords(body.dropoffCoords) };
};

const readRequest = (req) => {
  const trip = normalizeTrip(req);
  if (trip.error) return trip;
  const plan = series.normalizePlan(req.body || {});
  if (plan.error) return plan;
  return { trip, plan };
};

const routeOf = async (trip) => (trip.pickupCoords && trip.dropoffCoords
  ? tripMetrics(trip.pickupCoords, trip.dropoffCoords)
  : { miles: 0, minutes: 0, source: 'none' });

const fareFor = (settings, trip, metrics, pickupTime) => computeFare(settings, {
  serviceType: trip.serviceType, miles: metrics.miles, minutes: metrics.minutes, stayMinutes: trip.stayMinutes,
  pickupTime, distanceSource: metrics.source, extraChildren: trip.childIds.length - 1
});

// Before booking: the ride days and each ride's own fare (peak times differ).
router.post('/preview', protect, parentOnly, async (req, res) => {
  const input = readRequest(req);
  if (input.error) return res.status(input.status || 400).json({ message: input.error });
  try {
    const [settings, metrics] = await Promise.all([loadPricing(), routeOf(input.trip)]);
    const all = series.upcomingDays(input.plan, new Date(), 400);
    const rides = all.slice(0, 10).map((day) => {
      const fare = fareFor(settings, input.trip, metrics, day.pickupTime);
      return { date: day.date, pickupTime: day.pickupTime.toISOString(), total: fare.total, lines: fare.lines };
    });
    return res.json({ currency: settings.currency, rideCount: all.length, rides, distanceSource: metrics.source });
  } catch (error) { return sendError(res, error, 'Unable to price these rides'); }
});

router.post('/', protect, parentOnly, seriesLimiter, async (req, res) => {
  const input = readRequest(req);
  if (input.error) return res.status(input.status || 400).json({ message: input.error });
  try {
    const { count, error: countError } = await supabaseAdmin.from('ride_series').select('id', { count: 'exact', head: true })
      .eq('parent_id', req.user.id).eq('status', 'active');
    if (countError) throw countError;
    if (count >= series.MAX_ACTIVE_SERIES) return res.status(409).json({ message: `You can have up to ${series.MAX_ACTIVE_SERIES} repeating bookings. Cancel one to add another.` });
    await payments.requireCard(req.user.id);
    const metrics = await routeOf(input.trip);
    const { trip, plan } = input;
    const { data, error } = await supabaseAdmin.from('ride_series').insert({
      parent_id: req.user.id,
      child_ids: trip.childIds,
      pickup_location: trip.pickup,
      dropoff_location: trip.dropoff,
      pickup_coords: trip.pickupCoords,
      dropoff_coords: trip.dropoffCoords,
      service_type: trip.serviceType,
      stay_minutes: trip.stayMinutes,
      weekdays: plan.weekdays,
      pickup_local_time: plan.pickupLocalTime,
      time_zone: plan.timeZone,
      start_date: plan.startDate,
      end_date: plan.endDate,
      route_miles: metrics.miles,
      route_minutes: metrics.minutes,
      distance_source: metrics.source
    }).select('*').single();
    if (error) throw error;
    const created = await generateForParent(req.user.id);
    const rides = await seriesRides(data.id);
    if (rides[0]) await safely(() => notifyRideEvent(rides[0], 'booked'), 'Series booked notice failed');
    return res.status(201).json({ ...series.formatSeries(data, rides.map(formatRide)), createdRides: created });
  } catch (error) { return sendError(res, error, 'Unable to book these rides'); }
});

// Not-yet-started rides of one series, soonest first.
const seriesRides = (seriesId) => fetchRideRows(supabaseAdmin.from('rides').select(RIDE_SELECT)
  .eq('series_id', seriesId).in('status', scheduling.NOT_STARTED_STATUSES).order('pickup_time', { ascending: true }).limit(20));

router.get('/', protect, parentOnly, async (req, res) => {
  try {
    await safely(() => generateForParent(req.user.id), 'Series generation failed');
    const { data, error } = await supabaseAdmin.from('ride_series').select('*')
      .eq('parent_id', req.user.id).eq('status', 'active').order('created_at', { ascending: false }).limit(series.MAX_ACTIVE_SERIES * 2);
    if (error) throw error;
    const out = [];
    for (const row of data || []) out.push(series.formatSeries(row, (await seriesRides(row.id)).map(formatRide)));
    return res.json(out);
  } catch (error) { return sendError(res, error, 'Unable to load repeating rides'); }
});

const loadOwn = async (req, res) => {
  const { data, error } = await supabaseAdmin.from('ride_series').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!data || data.parent_id !== req.user.id) { res.status(404).json({ message: 'Repeating booking not found' }); return null; }
  if (data.status !== 'active') { res.status(409).json({ message: 'This repeating booking has already ended' }); return null; }
  return data;
};

// Cancels one generated ride the way the parent's own cancel would (same fee rules).
// Without pricing settings (outage) the fee is waived, as for single rides.
const cancelRide = async (ride, settings) => {
  const fee = !settings ? 0 : cancellationFee(settings, {
    total: Number(ride.price), createdAt: ride.created_at, pickupTime: ride.pickup_time,
    isScheduled: true, driverAssigned: !!ride.driver_id
  });
  const updated = await updateRideRow(ride.id, { status: 'cancelled', driver_location: null, cancellation_fee: fee }, ride.status);
  // Releases the card hold, or charges just the fee (the assigned driver gets their share).
  if (payments.enabled()) await safely(() => payments.settleRide(updated, { amount: fee, driverAmount: updated.driver_id ? fee * (settings?.driverShare ?? 0.8) : 0, purpose: 'cancellation_fee' }), 'Cancellation payment failed');
  await safely(() => notifyRideEvent(updated), 'Cancel notice failed');
  return fee;
};

const cancelFeeSafe = async (rides) => {
  const settings = await safely(loadPricing, 'Pricing failed');
  let total = 0;
  for (const ride of rides) total += await cancelRide(ride, settings);
  return Math.round(total * 100) / 100;
};

// Skip one day: no ride that day. Cancels it if it was already created.
router.put('/:id/skip', protect, parentOnly, seriesLimiter, async (req, res) => {
  try {
    const row = await loadOwn(req, res);
    if (!row) return undefined;
    const date = req.body?.date;
    if (!series.DATE.test(date || '')) return res.status(400).json({ message: 'Choose a day to skip' });
    const isRideDay = series.upcomingDays(series.planOf(row), new Date(), 400).some((d) => d.date === date);
    const existing = await fetchRideRows(supabaseAdmin.from('rides').select(RIDE_SELECT).eq('series_id', row.id).eq('series_date', date).limit(1));
    const ride = existing[0];
    if (!isRideDay && !ride) return res.status(400).json({ message: 'There is no upcoming ride that day' });
    if (ride && !scheduling.NOT_STARTED_STATUSES.includes(ride.status) && ride.status !== 'cancelled') return res.status(409).json({ message: 'That ride has already started' });
    const skipped = [...new Set([...(row.skipped_dates || []), date])].sort();
    const { data, error } = await supabaseAdmin.from('ride_series').update({ skipped_dates: skipped, updated_at: new Date().toISOString() })
      .eq('id', row.id).select('*').single();
    if (error) throw error;
    const fee = ride && ride.status !== 'cancelled' ? await cancelFeeSafe([ride]) : 0;
    return res.json({ ...series.formatSeries(data, (await seriesRides(row.id)).map(formatRide)), cancellationFee: fee });
  } catch (error) { return sendError(res, error, 'Unable to skip that day'); }
});

// Cancel the whole series: no new rides, and every ride not yet started is cancelled.
router.put('/:id/cancel', protect, parentOnly, seriesLimiter, async (req, res) => {
  try {
    const row = await loadOwn(req, res);
    if (!row) return undefined;
    const { error } = await supabaseAdmin.from('ride_series').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) throw error;
    const rides = await seriesRides(row.id);
    const fee = await cancelFeeSafe(rides);
    return res.json({ id: row.id, status: 'cancelled', cancelledRides: rides.length, cancellationFee: fee });
  } catch (error) { return sendError(res, error, 'Unable to cancel these rides'); }
});

module.exports = router;
