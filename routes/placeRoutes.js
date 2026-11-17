const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const places = require('../lib/places');

// Address suggestions for the mobile apps: /api/places. Signed-in accounts only,
// with a per-account limit, so the Google key behind it cannot be drained.
const router = express.Router();

const accountKey = (req) => (req.user && req.user.id ? `user:${req.user.id}` : null);
// Typing sends a search every few letters; a pick sends one look-up.
const searchLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120, message: 'Too many address searches. Wait a moment and try again.', keyPrefix: 'places-search', keyGenerator: accountKey });
const lookupLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 40, message: 'Too many address look-ups. Wait a moment and try again.', keyPrefix: 'places-lookup', keyGenerator: accountKey });

const SESSION = /^[A-Za-z0-9_-]{8,80}$/;
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

const answer = (res, error, fallback) => {
  const status = error.status >= 400 && error.status < 600 ? error.status : 502;
  if (status >= 500 && !error.code) console.error('Address search failed', error.message);
  return res.status(status).json({ message: error.status ? error.message : fallback, code: error.code || undefined });
};

router.post('/autocomplete', protect, searchLimiter, async (req, res) => {
  const input = typeof req.body.input === 'string' ? req.body.input.trim() : '';
  if (input.length < 3 || input.length > 120) return res.status(400).json({ message: 'Type at least 3 letters of the address.' });
  const sessionToken = typeof req.body.sessionToken === 'string' && SESSION.test(req.body.sessionToken) ? req.body.sessionToken : undefined;
  const near = req.body.near && typeof req.body.near === 'object' ? { lat: Number(req.body.near.lat), lng: Number(req.body.near.lng) } : null;
  try {
    return res.json({ suggestions: await places.suggest({ input, sessionToken, near: places.validPoint(near) ? near : null }) });
  } catch (error) {
    return answer(res, error, 'Address search is unavailable right now.');
  }
});

router.get('/:placeId', protect, lookupLimiter, async (req, res) => {
  if (!PLACE_ID.test(req.params.placeId)) return res.status(400).json({ message: 'Unknown place.' });
  const sessionToken = typeof req.query.sessionToken === 'string' && SESSION.test(req.query.sessionToken) ? req.query.sessionToken : undefined;
  try {
    return res.json(await places.resolve({ placeId: req.params.placeId, sessionToken }));
  } catch (error) {
    return answer(res, error, 'That place could not be loaded.');
  }
});

module.exports = router;
