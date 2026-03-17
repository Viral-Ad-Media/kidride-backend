const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const {
  fetchChildrenRowsByParentId,
  fetchUserById,
  formatChild,
  insertChildRow,
  updateProfileRowById
} = require('../lib/repository');

const router = express.Router();

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

router.get('/profile', protect, async (req, res) => {
  try {
    return res.json(formatUser(req.user));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.put('/profile', protect, async (req, res) => {
  try {
    const updates = {};
    const { name, phone, photoUrl } = req.body;

    if (typeof name === 'string') {
      updates.name = name.trim();
    }
    if (typeof phone === 'string') {
      updates.phone = phone.trim();
    }
    if (typeof photoUrl === 'string') {
      updates.photo_url = photoUrl.trim();
    }

    await updateProfileRowById(req.user.id, updates);
    const updatedUser = await fetchUserById(req.user.id);
    return res.json(formatUser(updatedUser));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/children', protect, async (req, res) => {
  try {
    const children = await fetchChildrenRowsByParentId(req.user.id);
    return res.json(children.map(formatChild));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/children', protect, async (req, res) => {
  try {
    const { name, age, notes, photoUrl } = req.body;
    const normalizedAge = Number(age);

    if (!name || !Number.isFinite(normalizedAge) || normalizedAge <= 0) {
      return res.status(400).json({ message: 'Valid child name and age are required' });
    }

    const createdChild = await insertChildRow({
      parent_id: req.user.id,
      name: String(name).trim(),
      age: normalizedAge,
      notes: typeof notes === 'string' ? notes.trim() : null,
      photo_url: typeof photoUrl === 'string' ? photoUrl.trim() : null
    });

    const children = await fetchChildrenRowsByParentId(req.user.id);

    return res.status(201).json({
      child: formatChild(createdChild),
      children: children.map(formatChild)
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/driver-application', protect, async (req, res) => {
  try {
    const { phone, vehicle, make, model, year, color, plate } = req.body;

    const incomingVehicle = vehicle && typeof vehicle === 'object'
      ? vehicle
      : { make, model, year, color, plate };

    await updateProfileRowById(req.user.id, {
      phone: typeof phone === 'string' ? phone.trim() : req.user.phone,
      vehicle: {
        make: incomingVehicle.make || req.user.vehicle?.make || '',
        model: incomingVehicle.model || req.user.vehicle?.model || '',
        year: incomingVehicle.year || req.user.vehicle?.year || '',
        color: incomingVehicle.color || req.user.vehicle?.color || '',
        plate: incomingVehicle.plate || req.user.vehicle?.plate || ''
      },
      driver_application_status: 'pending'
    });

    const updatedUser = await fetchUserById(req.user.id);

    return res.json({
      message: 'Driver application submitted successfully',
      user: formatUser(updatedUser)
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
