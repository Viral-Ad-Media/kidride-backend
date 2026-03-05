const express = require('express');
const router = express.Router();
const Ride = require('../models/Ride');
const { protect } = require('../middleware/authMiddleware');

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
const SAFE_WORDS = ['Lions', 'Falcon', 'Comet', 'Maple', 'Echo', 'Atlas'];
const VALID_RIDE_STATUSES = Ride.schema.path('status').enumValues;
const VALID_SERVICE_TYPES = Ride.schema.path('serviceType').enumValues;

const populateRideQuery = (query) => query
  .populate('driver', 'name vehicle photoUrl isVerifiedDriver')
  .populate('parent', 'name photoUrl');

const generateTripCode = () => Math.floor(1000 + Math.random() * 9000).toString();
const generateSafeWord = () => SAFE_WORDS[Math.floor(Math.random() * SAFE_WORDS.length)];

const normalizeRideRequestPayload = (body) => {
  const child = body.childId || body.child;
  const pickupLocation = body.pickupLocation || body.pickup;
  const dropoffLocation = body.dropoffLocation || body.dropoff;
  const price = Number(body.price);
  const pickupTime = body.pickupTime ? new Date(body.pickupTime) : undefined;

  if (!child || !pickupLocation || !dropoffLocation) {
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
  const userId = user._id.toString();
  const parentId = ride.parent?._id ? ride.parent._id.toString() : ride.parent?.toString();
  const driverId = ride.driver?._id ? ride.driver._id.toString() : ride.driver?.toString();

  return (
    parentId === userId ||
    driverId === userId
  );
};

// @route   POST /api/rides/request
router.post('/request', protect, async (req, res) => {
  try {
    const normalized = normalizeRideRequestPayload(req.body);
    if (normalized.error) {
      return res.status(400).json({ message: normalized.error });
    }

    const ride = await Ride.create({
      parent: req.user._id,
      child: normalized.child,
      pickupLocation: normalized.pickupLocation,
      dropoffLocation: normalized.dropoffLocation,
      pickupTime: normalized.pickupTime,
      status: 'searching_driver',
      price: normalized.price,
      tripCode: generateTripCode(),
      safeWord: generateSafeWord(),
      serviceType: normalized.serviceType
    });

    const populatedRide = await populateRideQuery(Ride.findById(ride._id));

    const io = req.app.get('io');
    if (io) {
      io.to('drivers').emit('ride_available', populatedRide);
    }

    res.status(201).json(populatedRide);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/rides/open
router.get('/open', protect, async (req, res) => {
  try {
    if (!['driver', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only drivers can view open ride requests' });
    }

    const requestedLimit = Number(req.query.limit) || 20;
    const limit = Math.max(1, Math.min(requestedLimit, 100));

    const rides = await populateRideQuery(
      Ride.find({
        status: { $in: OPEN_REQUEST_STATUSES },
        $or: [{ driver: { $exists: false } }, { driver: null }]
      })
        .sort({ createdAt: -1 })
        .limit(limit)
    );

    return res.json(rides);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/rides/active
router.get('/active', protect, async (req, res) => {
  try {
    const ride = await populateRideQuery(Ride.findOne({
      $or: [{ parent: req.user._id }, { driver: req.user._id }],
      status: { $nin: ['completed', 'cancelled'] }
    }).sort({ updatedAt: -1 }));
    
    res.json(ride);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/rides
router.get('/', protect, async (req, res) => {
  try {
    const { scope = 'all' } = req.query;
    const requestedLimit = Number(req.query.limit) || 50;
    const limit = Math.max(1, Math.min(requestedLimit, 100));

    const filter = req.user.role === 'admin'
      ? {}
      : { $or: [{ parent: req.user._id }, { driver: req.user._id }] };

    if (scope === 'active') {
      filter.status = { $nin: Array.from(TERMINAL_STATUSES) };
    } else if (scope === 'past') {
      filter.status = { $in: Array.from(TERMINAL_STATUSES) };
    } else if (scope === 'upcoming') {
      filter.status = { $in: UPCOMING_STATUSES };
    }

    const rides = await populateRideQuery(
      Ride.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
    );

    return res.json(rides);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/rides/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const ride = await populateRideQuery(Ride.findById(req.params.id));
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }
    if (!canAccessRide(req.user, ride)) {
      return res.status(403).json({ message: 'Not authorized to access this ride' });
    }
    return res.json(ride);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/rides/:id/accept
router.put('/:id/accept', protect, async (req, res) => {
  try {
    if (!['driver', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only drivers can accept rides' });
    }

    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }
    if (TERMINAL_STATUSES.has(ride.status)) {
      return res.status(409).json({ message: 'This ride is no longer available' });
    }
    if (!OPEN_REQUEST_STATUSES.includes(ride.status) && ride.status !== 'driver_assigned') {
      return res.status(409).json({ message: `Ride cannot be accepted from status ${ride.status}` });
    }
    if (ride.driver && ride.driver.toString() !== req.user._id.toString()) {
      return res.status(409).json({ message: 'Ride already accepted by another driver' });
    }

    ride.driver = req.user._id;
    ride.status = 'driver_assigned';
    await ride.save();
    const populatedRide = await populateRideQuery(Ride.findById(ride._id));

    const io = req.app.get('io');
    if (io) {
      io.to(ride.parent.toString()).emit('ride_accepted', populatedRide);
    }

    return res.json(populatedRide);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/rides/:id/status
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

    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }

    if (req.user.role === 'admin') {
      ride.status = status;
    } else if (req.user.role === 'driver') {
      if (!ride.driver || ride.driver.toString() !== req.user._id.toString()) {
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

    await ride.save();
    const populatedRide = await populateRideQuery(Ride.findById(ride._id));

    const io = req.app.get('io');
    if (io) {
      io.to(ride.parent.toString()).emit('ride_status_updated', populatedRide);
    }

    return res.json(populatedRide);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/rides/:id/cancel
router.put('/:id/cancel', protect, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }
    if (TERMINAL_STATUSES.has(ride.status)) {
      return res.status(409).json({ message: 'Ride is already completed or cancelled' });
    }

    const userId = req.user._id.toString();
    const isParent = ride.parent.toString() === userId;
    const isAssignedDriver = ride.driver && ride.driver.toString() === userId;
    const isAdmin = req.user.role === 'admin';
    if (!isParent && !isAssignedDriver && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized to cancel this ride' });
    }

    ride.status = 'cancelled';
    await ride.save();
    const populatedRide = await populateRideQuery(Ride.findById(ride._id));

    const io = req.app.get('io');
    if (io) {
      io.to(ride.parent.toString()).emit('ride_status_updated', populatedRide);
    }

    return res.json(populatedRide);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
