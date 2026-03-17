const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/authMiddleware');
const { createRateLimiter, parsePositiveInt } = require('../middleware/rateLimitMiddleware');
const { supabaseAdmin, supabaseAuth } = require('../config/supabase');
const { fetchUserById, upsertProfileRow } = require('../lib/repository');

const router = express.Router();

const authRateLimitWindowMs = parsePositiveInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const authRateLimitMaxAttempts = parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS, 20);
const authLimiter = createRateLimiter({
  windowMs: authRateLimitWindowMs,
  max: authRateLimitMaxAttempts,
  message: 'Too many authentication attempts. Please try again shortly.',
  keyPrefix: 'auth'
});

const VALID_ROLES = new Set(['parent', 'driver', 'admin']);
const normalizeEmail = (value = '') => value.trim().toLowerCase();

const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });

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

const createProfilePayload = ({ id, name, email, role }) => ({
  id,
  name,
  email,
  role,
  phone: null,
  photo_url: null,
  is_verified_driver: false,
  driver_application_status: 'none',
  vehicle: {}
});

const resolveAuthenticatedUser = async (userId, includeToken = false) => {
  const user = await fetchUserById(userId);
  if (!user) {
    throw new Error('Unable to load account profile');
  }

  return formatAuthUser(user, includeToken ? generateToken(user.id) : undefined);
};

const isExistingAccountError = (error) => {
  if (!error) {
    return false;
  }

  const message = String(error.message || '').toLowerCase();
  return error.status === 422 || message.includes('already been registered');
};

router.post('/register', authLimiter, async (req, res) => {
  const { name, email, password, role } = req.body;
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';
  const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : 'parent';

  if (!normalizedName || !normalizedEmail || !password) {
    return res.status(400).json({ message: 'name, email, and password are required' });
  }

  if (!VALID_ROLES.has(normalizedRole)) {
    return res.status(400).json({ message: 'role must be parent, driver, or admin' });
  }

  let createdUserId = null;

  try {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: {
        name: normalizedName,
        role: normalizedRole
      }
    });

    if (error) {
      if (isExistingAccountError(error)) {
        return res.status(400).json({ message: 'User already exists' });
      }

      throw error;
    }

    if (!data.user) {
      return res.status(400).json({ message: 'Invalid user data' });
    }

    createdUserId = data.user.id;

    await upsertProfileRow(createProfilePayload({
      id: data.user.id,
      name: normalizedName,
      email: normalizedEmail,
      role: normalizedRole
    }));

    return res.status(201).json(await resolveAuthenticatedUser(data.user.id, true));
  } catch (error) {
    if (createdUserId) {
      await supabaseAdmin.auth.admin.deleteUser(createdUserId);
    }

    return res.status(500).json({ message: error.message });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';

  if (!normalizedEmail || !password) {
    return res.status(400).json({ message: 'email and password are required' });
  }

  try {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email: normalizedEmail,
      password
    });

    if (error || !data.user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const userPayload = await resolveAuthenticatedUser(data.user.id, true);
    return res.json(userPayload);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/me', protect, async (req, res) => {
  try {
    return res.json(formatAuthUser(req.user));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
