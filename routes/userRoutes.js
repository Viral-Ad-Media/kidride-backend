const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');

const formatUser = (user) => ({
  id: user.id,
  _id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  phone: user.phone || null,
  photoUrl: user.photoUrl || null,
  children: user.children || [],
  isVerifiedDriver: !!user.isVerifiedDriver,
  driverApplicationStatus: user.driverApplicationStatus || 'none',
  vehicle: user.vehicle || {}
});

// @route   GET /api/users/profile
router.get('/profile', protect, async (req, res) => {
  try {
    res.json(formatUser(req.user));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/users/profile
router.put('/profile', protect, async (req, res) => {
  try {
    const { name, phone, photoUrl } = req.body;

    if (typeof name === 'string') {
      req.user.name = name.trim();
    }
    if (typeof phone === 'string') {
      req.user.phone = phone.trim();
    }
    if (typeof photoUrl === 'string') {
      req.user.photoUrl = photoUrl.trim();
    }

    await req.user.save();
    res.json(formatUser(req.user));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/users/children
router.get('/children', protect, async (req, res) => {
  try {
    res.json(req.user.children || []);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/users/children
router.post('/children', protect, async (req, res) => {
  try {
    const { name, age, notes, photoUrl } = req.body;
    const normalizedAge = Number(age);

    if (!name || !Number.isFinite(normalizedAge) || normalizedAge <= 0) {
      return res.status(400).json({ message: 'Valid child name and age are required' });
    }

    req.user.children.push({
      name: name.trim(),
      age: normalizedAge,
      notes: typeof notes === 'string' ? notes.trim() : undefined,
      photoUrl: typeof photoUrl === 'string' ? photoUrl.trim() : undefined
    });

    await req.user.save();
    const createdChild = req.user.children[req.user.children.length - 1];

    return res.status(201).json({
      child: createdChild,
      children: req.user.children
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/users/driver-application
router.post('/driver-application', protect, async (req, res) => {
  try {
    const { phone, vehicle, make, model, year, color, plate } = req.body;

    if (typeof phone === 'string') {
      req.user.phone = phone.trim();
    }

    const incomingVehicle = vehicle && typeof vehicle === 'object'
      ? vehicle
      : { make, model, year, color, plate };

    req.user.vehicle = {
      make: incomingVehicle.make || req.user.vehicle?.make || '',
      model: incomingVehicle.model || req.user.vehicle?.model || '',
      year: incomingVehicle.year || req.user.vehicle?.year || '',
      color: incomingVehicle.color || req.user.vehicle?.color || '',
      plate: incomingVehicle.plate || req.user.vehicle?.plate || ''
    };

    req.user.driverApplicationStatus = 'pending';

    await req.user.save();

    return res.json({
      message: 'Driver application submitted successfully',
      user: formatUser(req.user)
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
