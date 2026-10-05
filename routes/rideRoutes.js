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

const { isApprovedDriver, ACTIVE_STATUSES, quoteFare, redactOffer, generateTripCode, generateSafeWord, validateCoordinates } = require('../lib/security');
const { notifyRide } = require('../lib/push');
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
  if (body.serviceType && !VALID_SERVICE_TYPES.includes(body.serviceType)) {
    return { error: `serviceType must be one of: ${VALID_SERVICE_TYPES.join(', ')}` };
  }

  return {
    child: String(child),
    pickupLocation: String(pickupLocation).trim(),
    dropoffLocation: String(dropoffLocation).trim(),
    pickupTime,
    price,
    serviceType: body.serviceType || 'pickup_only'
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
        service_type: normalized.serviceType
      })
      .select('id')
      .single();

    if (error) {
      throw error;
    }

    const createdRide = await fetchRideRowById(data.id);
    const payload = formatRide(createdRide);
    const io = req.app.get('io');

    if (io) {
      io.to('drivers').emit('ride_available', redactOffer(payload));
    }

    return res.status(201).json(payload);
  } catch (error) {
    return res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ message: error.code === '23505' ? 'An active ride already exists for this account' : error.message });
  }
});

router.get('/open', protect, async (req, res) => {
  try {
    if (!isApprovedDriver(req.user) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only drivers can view open ride requests' });
    }

    const requestedLimit = Number(req.query.limit) || 20;
    const limit = Math.max(1, Math.min(requestedLimit, 100));
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
    const visibleRides = rides
      .filter((ride) => !declinedRideIds.has(ride.id))
      .slice(0, limit)
      .map(ride => redactOffer(formatRide(ride)));

    return res.json(visibleRides);
  } catch (error) {
    return res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ message: error.code === '23505' ? 'An active ride already exists for this account' : error.message });
  }
});

router.get('/active', protect, async (req, res) => {
  try {
    const rides = await fetchRideRows(
      supabaseAdmin
        .from('rides')
        .select(RIDE_SELECT)
        .or(orFilterForUser(req.user.id))
        .neq('status', 'completed')
        .neq('status', 'cancelled')
        .order('updated_at', { ascending: false })
        .limit(1)
    );

    return res.json(rides[0] ? formatRide(rides[0]) : null);
  } catch (error) {
    return res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ message: error.code === '23505' ? 'An active ride already exists for this account' : error.message });
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
    return res.json(rides.map(formatRide));
  } catch (error) {
    return res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ message: error.code === '23505' ? 'An active ride already exists for this account' : error.message });
  }
});

router.post('/quote', protect, (req, res) => {
  if (req.user.role !== 'parent') return res.status(403).json({ message: 'Only parents can obtain quotes' });
  if (!VALID_SERVICE_TYPES.includes(req.body.serviceType)) return res.status(400).json({ message: 'Invalid service type' });
  try { return res.json({ price: quoteFare(req.body.serviceType), currency: 'USD' }); }
  catch (error) { return res.status(error.status || 500).json({ message: error.message }); }
});

router.put('/:id/location', protect, async (req, res) => {
  try {
    if (!isApprovedDriver(req.user)) return res.status(403).json({ message: 'Approved driver required' });
    if (!validateCoordinates(req.body)) return res.status(400).json({ message: 'Invalid coordinates' });
    const ride = await fetchRideRowById(req.params.id);
    if (!ride || ride.driver_id !== req.user.id) return res.status(403).json({ message: 'Assigned driver required' });
    if (!ACTIVE_STATUSES.includes(ride.status)) return res.status(409).json({ message: 'Ride is not active' });
    const driver_location = { latitude: req.body.latitude, longitude: req.body.longitude, accuracy: req.body.accuracy ?? null, recordedAt: new Date().toISOString() };
    await updateRideRow(ride.id, { driver_location }, ride.status, req.user.id);
    return res.json(driver_location);
  } catch (error) { return res.status(error.status || 500).json({ message: error.message }); }
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
    return res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ message: error.code === '23505' ? 'An active ride already exists for this account' : error.message });
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
    const io = req.app.get('io');
    if (io) {
      io.to(data.parent_id).emit('ride_accepted', payload);
    }

    await notifyRide(data);
    return res.json(payload);
  } catch (error) {
    return res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ message: error.code === '23505' ? 'An active ride already exists for this account' : error.message });
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

    return res.json({ message: 'Ride declined' });
  } catch (error) {
    return res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ message: error.code === '23505' ? 'An active ride already exists for this account' : error.message });
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

    const updatedRide = await updateRideRow(req.params.id, { status: ride.status }, expectedStatus, req.user.role === 'driver' ? req.user.id : undefined);
    await notifyRide(updatedRide);
    const payload = formatRide(updatedRide);
    const io = req.app.get('io');

    if (io) {
      io.to(updatedRide.parent_id).emit('ride_status_updated', payload);
    }

    return res.json(payload);
  } catch (error) {
    return res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ message: error.code === '23505' ? 'An active ride already exists for this account' : error.message });
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
    const updatedRide = await updateRideRow(req.params.id, { status: 'cancelled' }, ride.status);
    await notifyRide(updatedRide);
    const payload = formatRide(updatedRide);
    const io = req.app.get('io');

    if (io) {
      io.to(updatedRide.parent_id).emit('ride_status_updated', payload);
    }

    return res.json(payload);
  } catch (error) {
    return res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ message: error.code === '23505' ? 'An active ride already exists for this account' : error.message });
  }
});

module.exports = router;
