const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { sendError } = require('../lib/http');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const { loadPricing } = require('../lib/pricingSettings');
const subscriptions = require('../lib/subscriptions');

// Monthly family plans: list plans, join one (Stripe Checkout), cancel or resume renewal.
const router = express.Router();

const fail = (res, error, fallback) => (error.status && error.status < 500 ? res.status(error.status).json({ message: error.message, code: error.code || undefined }) : sendError(res, error, fallback));
const parentOnly = (req, res, next) => (req.user.role === 'parent' ? next() : res.status(403).json({ message: 'Parent account required' }));
const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, message: 'Too many plan requests. Try again later.', keyPrefix: 'plans', keyGenerator: (req) => req.user?.id });

router.get('/', protect, parentOnly, async (req, res) => {
  try { return res.json(await subscriptions.overview(req.user.id, await loadPricing())); }
  catch (error) { return fail(res, error, 'Unable to load plans'); }
});

router.post('/checkout', protect, parentOnly, limiter, async (req, res) => {
  try { return res.json(await subscriptions.startCheckout(req.user, String(req.body.planId || ''), await loadPricing())); }
  catch (error) { return fail(res, error, 'Unable to start the plan'); }
});

router.post('/cancel', protect, parentOnly, limiter, async (req, res) => {
  try { return res.json({ subscription: await subscriptions.cancelAtPeriodEnd(req.user.id, true) }); }
  catch (error) { return fail(res, error, 'Unable to cancel the plan'); }
});

router.post('/resume', protect, parentOnly, limiter, async (req, res) => {
  try { return res.json({ subscription: await subscriptions.cancelAtPeriodEnd(req.user.id, false) }); }
  catch (error) { return fail(res, error, 'Unable to resume the plan'); }
});

module.exports = router;
