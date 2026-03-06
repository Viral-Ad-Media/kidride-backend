const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { createRateLimiter, parsePositiveInt } = require('../middleware/rateLimitMiddleware');

const authRateLimitWindowMs = parsePositiveInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const authRateLimitMaxAttempts = parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS, 20);
const authLimiter = createRateLimiter({
  windowMs: authRateLimitWindowMs,
  max: authRateLimitMaxAttempts,
  message: 'Too many authentication attempts. Please try again shortly.',
  keyPrefix: 'auth'
});

// Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

const formatAuthUser = (user, token) => {
  const payload = {
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
  };

  if (token) {
    payload.token = token;
  }

  return payload;
};

// @route   POST /api/auth/register
router.post('/register', authLimiter, async (req, res) => {
  const { name, email, password, role } = req.body;

  try {
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email, and password are required' });
    }
    if (role && !['parent', 'driver', 'admin'].includes(role)) {
      return res.status(400).json({ message: 'role must be parent, driver, or admin' });
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role: role || 'parent'
    });

    if (user) {
      return res.status(201).json(formatAuthUser(user, generateToken(user.id)));
    }

    return res.status(400).json({ message: 'Invalid user data' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ message: 'email and password are required' });
    }

    const user = await User.findOne({ email });
    if (user && (await bcrypt.compare(password, user.password))) {
      return res.json(formatAuthUser(user, generateToken(user.id)));
    } else {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  try {
    res.json(formatAuthUser(req.user));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
