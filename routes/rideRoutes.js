const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { createRateLimiter, parsePositiveInt } = require('../middleware/rateLimitMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const {
  RIDE_SELECT,
  fetchRideRowById,
  fetchRideRows,
  formatRide,
  updateRideRow
} = require('../lib/repository');

const { isApprovedDriver, ACTIVE_STATUSES, quoteFare, redactOffer, generateTripCode, generateSafeWord, validateCoordinates, parsePlaceCoords } = require('../lib/security');
const { notifyRide } = require('../lib/push');
const { sendError } = require('../lib/http');
const { MAX_COMMENT_LENGTH } = require('../lib/ratings');
const dispatch = require('../lib/dispatch');
const scheduling = require('../lib/scheduling');
const { timingSafeEqual } = require('node:crypto');

// Dispatch failures must never break booking, offers or tracking.
const safely = async (work, label) => { try { return await work(); } catch (error) { console.error(label, error); return undefined; } };
const router = express.Router();

const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const OPEN_REQUEST_STATUSES = ['requested', 'searching_driver'];
const UPCOMING_STATUSES = [
  'requested',
  'searching_driver',
  'driver_assigned',
  'driver_arrived_at_pickup'
];
const DRIVER_STATUS_TRANSITIONS = {
  driver_assigned: ['driver_arrived_at_pickup', 'cancelled'],
  driver_arrived_at_pickup: ['child_picked_up', 'cancelled'],
  child_picked_up: ['completed']
};
const VALID_RIDE_STATUSES = [
  'requested',
  'searching_driver',
  'driver_assigned',
  'driver_arrived_at_pickup',
  'child_picked_up',
  'completed',
  'cancelled'
];
const VALID_SERVICE_TYPES = [
  'pickup_only',
  'dropoff_only',
  'pickup_and_dropoff',
  'stay_with_child_and_dropoff'
];
const rideRequestRateLimitWindowMs = parsePositiveInt(process.env.RIDE_REQUEST_RATE_LIMIT_WINDOW_MS, 60 * 1000);
const rideRequestRateLimitMaxRequests = parsePositiveInt(process.env.RIDE_REQUEST_RATE_LIMIT_MAX_REQUESTS, 10);
const rideRequestLimiter = createRateLimiter({
  windowMs: rideRequestRateLimitWindowMs,
  max: rideRequestRateLimitMaxRequests,
  message: 'Too many ride requests. Please wait and try again.',
  keyPrefix: 'ride-request',
  keyGenerator: (req) => (req.user && req.user._id ? `user:${req.user._id}` : null)
});


const MAX_OPEN_RIDE_FETCH = 100;

const normalizeRideRequestPayload = (body) => {
  if (body.serviceType && !VALID_SERVICE_TYPES.includes(body.serviceType)) return { error: 'Invalid service type' };
  const child = body.childId || body.child;
  const pickupLocation = body.pickupLocation || body.pickup;
  const dropoffLocation = body.dropoffLocation || body.dropoff;
  let price;
  try { price = quoteFare(body.serviceType || 'pickup_only'); } catch (error) { return { error: error.message, status: error.status }; }
  const pickupTime = body.pickupTime ? new Date(body.pickupTime) : undefined;

  if (typeof child !== 'string' || typeof pickupLocation !== 'string' || !pickupLocation.trim() || typeof dropoffLocation !== 'string' || !dropoffLocation.trim()) {
    return { error: 'childId, pickup/pickupLocation, and dropoff/dropoffLocation are required' };
  }
  if (!Number.isFinite(price) || price < 0) {
    return { error: 'Valid ride price is required' };
  }
  if (pickupTime && Number.isNaN(pickupTime.getTime())) {
    return { error: 'pickupTime must be a valid date' };
  }
  const scheduled = body.scheduled === true;
  if (scheduled) {
    const timeError = scheduling.validateScheduledTime(pickupTime);
    if (timeError) return { error: timeError };
  }
  if (body.serviceType && !VALID_SERVICE_TYPES.includes(body.serviceType)) {
    return { error: `serviceType must be one of: ${VALID_SERVICE_TYPES.join(', ')}` };
  }

  return {
    child: String(child),
    pickupLocation: String(pickupLocation).trim(),
    dropoffLocation: String(dropoffLocation).trim(),
    pickupTime,
    scheduled,
    price,
    serviceType: body.serviceType || 'pickup_only',
    pickupCoords: parsePlaceCoords(body.pickupCoords),
    dropoffCoords: parsePlaceCoords(body.dropoffCoords)
  };
};

const canAccessRide = (user, ride) => {
  if (user.role === 'admin') {
    return true;
  }

  return ride.parent_id === user.id || ride.driver_id === user.id;
};

const orFilterForUser = (userId) => `parent_id.eq.${userId},driver_id.eq.${userId}`;

const fetchDeclinedRideIdsByDriver = async (driverId) => {
  const { data, error } = await supabaseAdmin
    .from('ride_declines')
    .select('ride_id')
    .eq('driver_id', driverId);

  if (error) {
    throw error;
  }

  return new Set((data || []).map((row) => row.ride_id));
};

router.post('/request', protect, rideRequestLimiter, async (req, res) => {
  try {
    if (req.user.role !== 'parent') return res.status(403).json({ message: 'Only parents can request rides' });
    const childId = req.body.childId || req.body.child;
    if (!(req.user.children || []).some(child => child.id === childId)) return res.status(403).json({ message: 'Select a child from your account' });
    const normalized = normalizeRideRequestPayload(req.body);
    if (normalized.error) {
      return res.status(normalized.status || 400).json({ message: normalized.error });
    }

    if (typeof req.body.quotedPrice !== 'number' || req.body.quotedPrice !== normalized.price) return res.status(409).json({ message: 'Fare changed or quote missing. Get a current quote before booking.' });
    if (normalized.scheduled) {
      const { count, error: countError } = await supabaseAdmin.from('rides').select('id', { count: 'exact', head: true })
        .eq('parent_id', req.user.id).eq('is_scheduled', true).in('status', scheduling.NOT_STARTED_STATUSES);
      if (countError) throw countError;
      if (count >= scheduling.MAX_SCHEDULED_PER_PARENT) return res.status(409).json({ message: `You can have up to ${scheduling.MAX_SCHEDULED_PER_PARENT} upcoming rides. Cancel one to book another.` });
    }
    const { data, error } = await supabaseAdmin
      .from('rides')
      .insert({
        parent_id: req.user.id,
        child_id: normalized.child,
        pickup_location: normalized.pickupLocation,
        dropoff_location: normalized.dropoffLocation,
        pickup_time: normalized.pickupTime ? normalized.pickupTime.toISOString() : null,
        status: 'searching_driver',
        price: normalized.price,
        trip_code: generateTripCode(),
        safe_word: generateSafeWord(),
        service_type: normalized.serviceType,
        pickup_coords: normalized.pickupCoords,
        dropoff_coords: normalized.dropoffCoords,
        // With a known pickup point the ride goes to the nearest drivers first.
        // A ride for later waits (held) until its dispatch window opens.
        dispatch_state: normalized.pickupCoords && !normalized.scheduled ? 'targeted' : 'open',
        ...(normalized.scheduled ? { is_scheduled: true } : {})
      })
      .select('id')
      .single();

    if (error?.code === '23505') {
      // Until the old one-ride-per-parent index is removed, any unfinished ride blocks a new booking.
      return res.status(409).json({ message: normalized.scheduled
        ? 'Finish or cancel your current ride before scheduling another one.'
        : 'You already have a ride in progress. Finish or cancel it before booking another ride now.' });
    }
    if (error) {
      throw error;
    }

    let createdRide = await fetchRideRowById(data.id);
    if (createdRide.dispatch_state === 'targeted') {
      await safely(() => dispatch.advanceDispatch(createdRide), 'Dispatch failed to start');
      createdRide = await fetchRideRowById(data.id);
    }
    const payload = formatRide(createdRide);
    const io = req.app.get('io');

    if (io) {
      io.to('drivers').emit('ride_available', redactOffer(payload));
    }

    return res.status(201).json(payload);
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/open', protect, async (req, res) => {
  try {
    if (!isApprovedDriver(req.user) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only drivers can view open ride requests' });
    }

    const requestedLimit = Number(req.query.limit) || 20;
    const limit = Math.max(1, Math.min(requestedLimit, 100));
    // Move nearest-driver offers along before deciding what this driver sees.
    await safely(() => dispatch.releaseDueScheduledRides(), 'Scheduled release failed');
    await safely(async () => {
      const { data: targeted, error: targetedError } = await supabaseAdmin.from('rides').select('id, status, driver_id, dispatch_state, pickup_coords')
        .eq('dispatch_state', 'targeted').in('status', OPEN_REQUEST_STATUSES).is('driver_id', null).limit(20);
      if (targetedError) throw targetedError;
      for (const ride of targeted || []) await dispatch.advanceDispatch(ride);
    }, 'Dispatch advance failed');
    const rides = await fetchRideRows(
      supabaseAdmin
        .from('rides')
        .select(RIDE_SELECT)
        .in('status', OPEN_REQUEST_STATUSES)
        .is('driver_id', null)
        .order('created_at', { ascending: false })
        .limit(MAX_OPEN_RIDE_FETCH)
    );

    if (req.user.role === 'admin') {
      return res.json(rides.slice(0, limit).map(formatRide));
    }

    const declinedRideIds = await fetchDeclinedRideIdsByDriver(req.user.id);
    const liveOffers = (await safely(() => dispatch.fetchLiveOffers(req.user.id), 'Offer lookup failed')) || new Map();
    // A targeted ride is only visible to the driver it is currently offered to;
    // their own offers come first, with the time left to accept.
    const visibleRides = rides
      .filter((ride) => !declinedRideIds.has(ride.id) && !scheduling.isHeld(ride))
      .filter((ride) => ride.dispatch_state !== 'targeted' || liveOffers.has(ride.id))
      .sort((a, b) => Number(liveOffers.has(b.id)) - Number(liveOffers.has(a.id)))
      .slice(0, limit)
      .map((ride) => ({ ...redactOffer(formatRide(ride)), offerExpiresAt: liveOffers.get(ride.id) || null }));

    return res.json(visibleRides);
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/active', protect, async (req, res) => {
  try {
    // Rides booked for later stay in the Upcoming lists until shortly before pickup.
    const activeQuery = async () => (await fetchRideRows(
      supabaseAdmin
        .from('rides')
        .select(RIDE_SELECT)
        .or(orFilterForUser(req.user.id))
        .neq('status', 'completed')
        .neq('status', 'cancelled')
        .order('updated_at', { ascending: false })
        .limit(12)
    )).filter((candidate) => scheduling.isCurrent(candidate));
    await safely(() => dispatch.releaseDueScheduledRides(), 'Scheduled release failed');
    let [ride] = await activeQuery();
    if (!ride) return res.json(null);

    // While a parent waits, keep dispatch moving and say how many drivers are near.
    let searchInfo;
    if (req.user.id === ride.parent_id && !ride.driver_id && OPEN_REQUEST_STATUSES.includes(ride.status)) {
      if (ride.dispatch_state === 'targeted') {
        await safely(() => dispatch.advanceDispatch(ride), 'Dispatch advance failed');
        [ride] = await activeQuery();
      }
      if (ride && ride.pickup_coords) {
        const nearby = await safely(() => dispatch.findNearbyDrivers(ride.pickup_coords), 'Nearby lookup failed');
        searchInfo = { nearbyDrivers: Array.isArray(nearby) ? nearby.length : null };
      }
    }
    if (!ride) return res.json(null);
    return res.json(searchInfo ? { ...formatRide(ride), dispatch: searchInfo } : formatRide(ride));
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/', protect, async (req, res) => {
  try {
    const { scope = 'all' } = req.query;
    const requestedLimit = Number(req.query.limit) || 50;
    const limit = Math.max(1, Math.min(requestedLimit, 100));

    let query = supabaseAdmin
      .from('rides')
      .select(RIDE_SELECT)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (req.user.role !== 'admin') {
      query = query.or(orFilterForUser(req.user.id));
    }

    if (scope === 'active') {
      query = query.neq('status', 'completed').neq('status', 'cancelled');
    } else if (scope === 'past') {
      query = query.in('status', Array.from(TERMINAL_STATUSES));
    } else if (scope === 'upcoming') {
      query = query.in('status', UPCOMING_STATUSES);
    }

    const rides = await fetchRideRows(query);
    const formatted = rides.map(formatRide);
    // Parents see which of their rides they have already rated.
    if (req.user.role === 'parent' && formatted.length) {
      const { data: ratings, error: ratingError } = await supabaseAdmin.from('ride_ratings').select('ride_id, stars, comment').in('ride_id', formatted.map((ride) => ride.id));
      if (ratingError) throw ratingError;
      const byRide = new Map((ratings || []).map((row) => [row.ride_id, { stars: row.stars, comment: row.comment || null }]));
      for (const ride of formatted) ride.rating = byRide.get(ride.id) || null;
    }
    return res.json(formatted);
  } catch (error) {
    return sendError(res, error);
  }
});

// Upcoming rides booked for later: a parent's own (not yet started), or the
// ones a driver has accepted. Soonest first.
router.get('/scheduled', protect, async (req, res) => {
  try {
    if (req.user.role !== 'parent' && !isApprovedDriver(req.user)) return res.status(403).json({ message: 'Parent or approved driver account required' });
    await safely(() => dispatch.releaseDueScheduledRides(), 'Scheduled release failed');
    let query = supabaseAdmin.from('rides').select(RIDE_SELECT).eq('is_scheduled', true)
      .order('pickup_time', { ascending: true }).limit(scheduling.MAX_SCHEDULED_PER_PARENT * 2);
    query = req.user.role === 'parent'
      ? query.eq('parent_id', req.user.id).in('status', scheduling.NOT_STARTED_STATUSES)
      : query.eq('driver_id', req.user.id).eq('status', 'driver_assigned');
    const rides = await fetchRideRows(query);
    return res.json(rides.map((ride) => (req.user.role === 'parent' ? formatRide(ride) : redactOffer(formatRide(ride)))));
  } catch (error) {
    return sendError(res, error);
  }
});

// Cron: releases due rides for later and moves offers along even when nobody
// is polling. Vercel Cron (or any scheduler) calls it with CRON_SECRET.
router.get('/scheduled/dispatch', async (req, res) => {
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  const actual = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return res.status(401).json({ message: 'Not authorized' });
  try {
    const released = await dispatch.releaseDueScheduledRides();
    const { data: targeted, error } = await supabaseAdmin.from('rides').select('id, status, driver_id, dispatch_state, pickup_coords')
      .eq('dispatch_state', 'targeted').in('status', OPEN_REQUEST_STATUSES).is('driver_id', null).limit(50);
    if (error) throw error;
    for (const ride of targeted || []) await dispatch.advanceDispatch(ride);
    return res.json({ released, advanced: (targeted || []).length });
  } catch (error) {
    return sendError(res, error, 'Scheduled dispatch failed');
  }
});

router.get('/summary', protect, async (req, res) => {
  if (req.user.role !== 'driver') return res.status(403).json({ message: 'Driver account required' });
  try {
    const { data, error } = await supabaseAdmin.rpc('driver_ride_summary', { p_driver: req.user.id });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return res.json({ completedCount: Number(row?.completed_count) || 0, totalEarnings: Number(row?.total_earnings) || 0 });
  } catch (error) { return sendError(res, error, 'Unable to load ride summary'); }
});

// Every service type with its current fixed price, so parents can compare before booking.
router.get('/prices', protect, (req, res) => {
  try {
    return res.json({ currency: 'USD', prices: Object.fromEntries(VALID_SERVICE_TYPES.map((type) => [type, quoteFare(type)])) });
  } catch (error) { return sendError(res, error); }
});

router.post('/quote', protect, (req, res) => {
  if (req.user.role !== 'parent') return res.status(403).json({ message: 'Only parents can obtain quotes' });
  if (!VALID_SERVICE_TYPES.includes(req.body.serviceType)) return res.status(400).json({ message: 'Invalid service type' });
  try { return res.json({ price: quoteFare(req.body.serviceType), currency: 'USD' }); }
  catch (error) { return sendError(res, error); }
});

router.put('/:id/location', protect, async (req, res) => {
  try {
    if (!isApprovedDriver(req.user)) return res.status(403).json({ message: 'Approved driver required' });
    if (!validateCoordinates(req.body)) return res.status(400).json({ message: 'Invalid coordinates' });
    const ride = await fetchRideRowById(req.params.id);
    if (!ride || ride.driver_id !== req.user.id) return res.status(403).json({ message: 'Assigned driver required' });
    if (!ACTIVE_STATUSES.includes(ride.status)) return res.status(409).json({ message: 'Ride is not active' });
    const driver_location = { latitude: req.body.latitude, longitude: req.body.longitude, accuracy: req.body.accuracy ?? null, heading: req.body.heading ?? null, speed: req.body.speed ?? null, recordedAt: new Date().toISOString() };
    await updateRideRow(ride.id, { driver_location }, ride.status, req.user.id);
    return res.json(driver_location);
  } catch (error) { return sendError(res, error); }
});

router.get('/:id', protect, async (req, res) => {
  try {
    const ride = await fetchRideRowById(req.params.id);
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }
    if (!canAccessRide(req.user, ride)) {
      return res.status(403).json({ message: 'Not authorized to access this ride' });
    }
    return res.json(formatRide(ride));
  } catch (error) {
    return sendError(res, error);
  }
});

// The parent moves a ride booked for later, until it is offered to drivers.
router.put('/:id/schedule', protect, async (req, res) => {
  try {
    const ride = await fetchRideRowById(req.params.id);
    if (!ride || ride.parent_id !== req.user.id) return res.status(404).json({ message: 'Ride not found' });
    if (!ride.is_scheduled) return res.status(409).json({ message: 'Only rides booked for later can be rescheduled' });
    if (!scheduling.isHeld(ride)) return res.status(409).json({ message: 'Drivers are already being contacted for this ride, so its time can no longer be changed. Cancel it and book again instead.' });
    const pickupTime = new Date(req.body.pickupTime);
    const timeError = scheduling.validateScheduledTime(pickupTime);
    if (timeError) return res.status(400).json({ message: timeError });
    // Only while still held: a release in the meantime wins.
    const { data, error } = await supabaseAdmin.from('rides')
      .update({ pickup_time: pickupTime.toISOString(), updated_at: new Date().toISOString() })
      .eq('id', ride.id).eq('status', ride.status).is('dispatch_released_at', null)
      .select(RIDE_SELECT).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ message: 'Drivers are already being contacted for this ride, so its time can no longer be changed.' });
    return res.json(formatRide(data));
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/:id/accept', protect, async (req, res) => {
  try {
    if (!isApprovedDriver(req.user) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only drivers can accept rides' });
    }

    const existingRide = await fetchRideRowById(req.params.id);
    if (!existingRide) {
      return res.status(404).json({ message: 'Ride not found' });
    }
    if (TERMINAL_STATUSES.has(existingRide.status)) {
      return res.status(409).json({ message: 'This ride is no longer available' });
    }

    if (existingRide.status === 'driver_assigned' && existingRide.driver_id === req.user.id) {
      return res.json(formatRide(existingRide));
    }

    if (!OPEN_REQUEST_STATUSES.includes(existingRide.status) && existingRide.status !== 'driver_assigned') {
      return res.status(409).json({ message: `Ride cannot be accepted from status ${existingRide.status}` });
    }
    if (existingRide.driver_id && existingRide.driver_id !== req.user.id) {
      return res.status(409).json({ message: 'Ride already accepted by another driver' });
    }
    if (req.user.role !== 'admin' && scheduling.isHeld(existingRide)) {
      return res.status(409).json({ message: 'This ride is booked for later and is not open to drivers yet.' });
    }
    if (req.user.role !== 'admin' && existingRide.dispatch_state === 'targeted') {
      const liveOffers = await dispatch.fetchLiveOffers(req.user.id);
      if (!liveOffers.has(existingRide.id)) return res.status(409).json({ message: 'This ride is being offered to a closer driver right now.' });
    }

    const { data, error } = await supabaseAdmin
      .from('rides')
      .update({
        driver_id: req.user.id,
        status: 'driver_assigned',
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .is('driver_id', null)
      .in('status', OPEN_REQUEST_STATUSES)
      .select(RIDE_SELECT)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      const latestRide = await fetchRideRowById(req.params.id);
      if (!latestRide) {
        return res.status(404).json({ message: 'Ride not found' });
      }
      if (latestRide.driver_id && latestRide.driver_id !== req.user.id) {
        return res.status(409).json({ message: 'Ride already accepted by another driver' });
      }
      if (TERMINAL_STATUSES.has(latestRide.status)) {
        return res.status(409).json({ message: 'This ride is no longer available' });
      }
      return res.status(409).json({ message: `Ride cannot be accepted from status ${latestRide.status}` });
    }

    const payload = formatRide(data);
    await safely(() => dispatch.setOfferStatus(data.id, req.user.id, 'accepted'), 'Offer update failed');
    const io = req.app.get('io');
    if (io) {
      io.to(data.parent_id).emit('ride_accepted', payload);
    }

    await notifyRide(data);
    return res.json(payload);
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/:id/decline', protect, async (req, res) => {
  try {
    if (!isApprovedDriver(req.user)) {
      return res.status(403).json({ message: 'Only drivers can decline rides' });
    }

    const ride = await fetchRideRowById(req.params.id);
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }
    if (TERMINAL_STATUSES.has(ride.status)) {
      return res.status(409).json({ message: 'This ride is no longer available' });
    }
    if (!OPEN_REQUEST_STATUSES.includes(ride.status)) {
      return res.status(409).json({ message: `Ride cannot be declined from status ${ride.status}` });
    }
    if (ride.driver_id) {
      return res.status(409).json({ message: 'Ride has already been assigned' });
    }

    const { error } = await supabaseAdmin
      .from('ride_declines')
      .upsert({
        ride_id: req.params.id,
        driver_id: req.user.id
      }, {
        onConflict: 'ride_id,driver_id',
        ignoreDuplicates: true
      });

    if (error) {
      throw error;
    }

    // Pass a targeted ride straight to the next nearest driver.
    await safely(async () => {
      await dispatch.setOfferStatus(ride.id, req.user.id, 'declined');
      await dispatch.advanceDispatch(ride);
    }, 'Dispatch advance after decline failed');

    return res.json({ message: 'Ride declined' });
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/:id/status', protect, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ message: 'status is required' });
    }
    if (!VALID_RIDE_STATUSES.includes(status)) {
      return res.status(400).json({
        message: `status must be one of: ${VALID_RIDE_STATUSES.join(', ')}`
      });
    }

    const ride = await fetchRideRowById(req.params.id);
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }

    const expectedStatus = ride.status;
    if (req.user.role === 'admin') {
      if (TERMINAL_STATUSES.has(ride.status)) return res.status(409).json({ message: 'Terminal rides cannot be reopened' });
      ride.status = status;
    } else if (req.user.role === 'driver') {
      if (!ride.driver_id || ride.driver_id !== req.user.id) {
        return res.status(403).json({ message: 'Only the assigned driver can update ride status' });
      }
      if (!isApprovedDriver(req.user)) {
        return res.status(403).json({ message: 'Approved driver required' });
      }
      const allowedNextStatuses = DRIVER_STATUS_TRANSITIONS[ride.status] || [];
      if (!allowedNextStatuses.includes(status)) {
        return res.status(409).json({
          message: `Invalid status transition from ${ride.status} to ${status}`
        });
      }
      ride.status = status;
    } else {
      return res.status(403).json({ message: 'Only drivers can update ride status' });
    }

    let updatedRide;
    try {
      updatedRide = await updateRideRow(req.params.id, { status: ride.status, ...(TERMINAL_STATUSES.has(ride.status) ? { driver_location: null } : {}) }, expectedStatus, req.user.role === 'driver' ? req.user.id : undefined);
    } catch (updateError) {
      // Starting a ride booked for later while another trip is still under way.
      if (updateError?.code === '23505') return res.status(409).json({ message: 'Finish your current trip before starting this one.' });
      throw updateError;
    }
    await notifyRide(updatedRide);
    const payload = formatRide(updatedRide);
    const io = req.app.get('io');

    if (io) {
      io.to([updatedRide.parent_id, updatedRide.driver_id].filter(Boolean)).emit('ride_status_updated', payload);
    }

    return res.json(payload);
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/:id/cancel', protect, async (req, res) => {
  try {
    const ride = await fetchRideRowById(req.params.id);
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }
    if (TERMINAL_STATUSES.has(ride.status)) {
      return res.status(409).json({ message: 'Ride is already completed or cancelled' });
    }

    const isParent = ride.parent_id === req.user.id;
    const isAssignedDriver = ride.driver_id && ride.driver_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isParent && !isAssignedDriver && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized to cancel this ride' });
    }

    if (ride.status === 'child_picked_up' && !isAdmin) return res.status(409).json({ message: 'A trip with a child onboard cannot be cancelled. Contact support.' });
    const updatedRide = await updateRideRow(req.params.id, { status: 'cancelled', driver_location: null }, ride.status);
    await notifyRide(updatedRide);
    const payload = formatRide(updatedRide);
    const io = req.app.get('io');

    if (io) {
      io.to([updatedRide.parent_id, updatedRide.driver_id].filter(Boolean)).emit('ride_status_updated', payload);
    }

    return res.json(payload);
  } catch (error) {
    return sendError(res, error);
  }
});

// The parent rates the driver of their completed ride once: 1-5 stars and an optional comment.
router.post('/:id/rating', protect, async (req, res) => {
  const stars = Number(req.body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return res.status(400).json({ message: 'Choose between 1 and 5 stars' });
  const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
  if (comment.length > MAX_COMMENT_LENGTH) return res.status(400).json({ message: `Keep the review under ${MAX_COMMENT_LENGTH} characters` });
  try {
    const ride = await fetchRideRowById(req.params.id);
    if (!ride) return res.status(404).json({ message: 'Ride not found' });
    if (req.user.role !== 'parent' || ride.parent_id !== req.user.id) return res.status(403).json({ message: 'Only the parent who booked this ride can rate it' });
    if (ride.status !== 'completed' || !ride.driver_id) return res.status(409).json({ message: 'Only completed rides can be rated' });
    const { data, error } = await supabaseAdmin.from('ride_ratings')
      .insert({ ride_id: ride.id, parent_id: req.user.id, driver_id: ride.driver_id, stars, comment: comment || null })
      .select('stars, comment, created_at').single();
    if (error?.code === '23505') return res.status(409).json({ message: 'You have already rated this ride' });
    if (error) throw error;
    return res.status(201).json({ rideId: ride.id, stars: data.stars, comment: data.comment || null, createdAt: data.created_at });
  } catch (error) {
    return sendError(res, error, 'Unable to save your rating');
  }
});

module.exports = router;
