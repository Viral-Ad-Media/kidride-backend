const express = require('express');
const router = express.Router();
const Ride = require('../models/Ride');
const { protect } = require('../middleware/authMiddleware');

// @route   POST /api/rides/request
router.post('/request', protect, async (req, res) => {
  try {
    const { childId, pickup, dropoff, price, serviceType } = req.body;
    
    // Generate simple codes
    const tripCode = Math.floor(1000 + Math.random() * 9000).toString();
    const safeWord = "Lions"; // In real app, pick random word

    const ride = await Ride.create({
      parent: req.user._id,
      child: childId,
      pickupLocation: pickup,
      dropoffLocation: dropoff,
      status: 'searching_driver',
      price,
      tripCode,
      safeWord,
      serviceType
    });

    // Emitting socket event would happen in server.js or controller
    // req.app.get('io').emit('new_ride', ride);

    res.status(201).json(ride);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/rides/active
router.get('/active', protect, async (req, res) => {
  try {
    const ride = await Ride.findOne({ 
      $or: [{ parent: req.user._id }, { driver: req.user._id }],
      status: { $nin: ['completed', 'cancelled'] }
    }).populate('driver', 'name vehicle photoUrl').populate('parent', 'name');
    
    res.json(ride);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;