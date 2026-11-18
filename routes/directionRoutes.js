const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const { parsePlaceCoords } = require('../lib/security');
const { drivingRoute } = require('../lib/routeMetrics');

// The driving route for the mobile apps' maps: /api/directions. Signed-in
// accounts only, with a per-account limit, so the Google key behind it cannot
// be drained. The apps ask once per trip, and for a moving car at most every 20 seconds.
// `steps: true` adds the turns in order, for the driver's in-app directions.
const router = express.Router();

const limiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 40,
  message: 'Too many route requests. Wait a moment and try again.',
  keyPrefix: 'directions',
  keyGenerator: (req) => (req.user && req.user.id ? `user:${req.user.id}` : null)
});

router.post('/', protect, limiter, async (req, res) => {
  const origin = parsePlaceCoords(req.body.origin);
  const destination = parsePlaceCoords(req.body.destination);
  if (!origin || !destination) return res.status(400).json({ message: 'origin and destination need a lat and lng.' });
  try {
    return res.json(await drivingRoute(origin, destination, { steps: req.body.steps === true }));
  } catch (error) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502;
    if (!error.status) console.error('Route lookup failed', error.message);
    return res.status(status).json({ message: error.status ? error.message : 'The route could not be loaded right now.', code: error.code || undefined });
  }
});

module.exports = router;
