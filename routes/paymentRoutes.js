const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { sendError } = require('../lib/http');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const payments = require('../lib/payments');
const plateReader = require('../lib/plateReader');
const faceMatch = require('../lib/faceMatch');
const identity = require('../lib/identityProvider');
const backgroundCheck = require('../lib/backgroundCheck');

// Payments: the parent's saved card, payment confirmation/retry for a ride,
// driver payouts, admin refunds, and which outside providers are switched on.
const router = express.Router();

const fail = (res, error, fallback) => (error.status && error.status < 500 ? res.status(error.status).json({ message: error.message, code: error.code || undefined }) : sendError(res, error, fallback));
const only = (role) => (req, res, next) => (req.user.role === role ? next() : res.status(403).json({ message: `${role[0].toUpperCase()}${role.slice(1)} account required` }));
const whenEnabled = (_req, res, next) => (payments.enabled() ? next() : res.status(409).json({ message: 'Payments are not switched on yet', code: 'payments_off' }));
const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, message: 'Too many payment requests. Try again later.', keyPrefix: 'payments', keyGenerator: (req) => req.user?.id });

/** What the app needs: whether payments are on, the publishable key, and the caller's card. */
router.get('/config', protect, async (req, res) => {
  try {
    if (!payments.enabled()) return res.json({ enabled: false });
    const account = req.user.role === 'parent' ? await payments.loadAccount(req.user.id) : null;
    return res.json({ enabled: true, testMode: payments.testMode(), publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, card: payments.card(account) });
  } catch (error) { return fail(res, error, 'Unable to load payment settings'); }
});

// Parent card
router.post('/card/setup', protect, only('parent'), whenEnabled, limiter, async (req, res) => {
  try { return res.json(await payments.startCardSetup(req.user)); } catch (error) { return fail(res, error, 'Unable to start adding a card'); }
});
router.post('/card/confirm', protect, only('parent'), whenEnabled, limiter, async (req, res) => {
  try { return res.json({ card: await payments.finishCardSetup(req.user, req.body.setupIntentId) }); } catch (error) { return fail(res, error, 'Unable to save the card'); }
});
router.delete('/card', protect, only('parent'), whenEnabled, async (req, res) => {
  try { return res.json({ card: await payments.removeCard(req.user) }); } catch (error) { return fail(res, error, 'Unable to remove the card'); }
});

// Ride payments (parent)
router.get('/rides/:id', protect, whenEnabled, async (req, res) => {
  try {
    const row = await payments.loadRidePayment(req.params.id);
    if (!row || (req.user.role !== 'admin' && row.parent_id !== req.user.id)) return res.status(404).json({ message: 'No payment for this ride' });
    return res.json({ payment: payments.publicPayment(row) });
  } catch (error) { return fail(res, error, 'Unable to load the payment'); }
});
router.post('/rides/:id/action', protect, only('parent'), whenEnabled, limiter, async (req, res) => {
  try { return res.json(await payments.actionFor(req.params.id, req.user.id)); } catch (error) { return fail(res, error, 'Unable to confirm the payment'); }
});
router.post('/rides/:id/confirmed', protect, only('parent'), whenEnabled, limiter, async (req, res) => {
  try { return res.json({ payment: payments.publicPayment(await payments.confirmedByParent(req.params.id, req.user.id)) }); } catch (error) { return fail(res, error, 'Unable to update the payment'); }
});
router.post('/rides/:id/retry', protect, whenEnabled, limiter, async (req, res) => {
  try {
    if (!['parent', 'admin'].includes(req.user.role)) return res.status(403).json({ message: 'Not allowed' });
    return res.json({ payment: payments.publicPayment(await payments.retryRide(req.params.id, req.user.role === 'admin' ? null : req.user.id)) });
  } catch (error) { return fail(res, error, 'Unable to retry the payment'); }
});

// Driver payouts
router.get('/payouts', protect, only('driver'), whenEnabled, async (req, res) => {
  try { return res.json(await payments.payoutSummary(req.user.id)); } catch (error) { return fail(res, error, 'Unable to load payouts'); }
});
router.post('/payouts/onboarding', protect, only('driver'), whenEnabled, limiter, async (req, res) => {
  try { return res.json(await payments.payoutOnboardingLink(req.user)); } catch (error) { return fail(res, error, 'Unable to open payout setup'); }
});
router.post('/payouts/dashboard', protect, only('driver'), whenEnabled, limiter, async (req, res) => {
  try { return res.json(await payments.payoutDashboardLink(req.user.id)); } catch (error) { return fail(res, error, 'Unable to open your payout dashboard'); }
});

// Admin
router.post('/rides/:id/refund', protect, only('admin'), whenEnabled, async (req, res) => {
  try {
    const amount = req.body.amount === undefined || req.body.amount === null || req.body.amount === '' ? undefined : Number(req.body.amount);
    if (amount !== undefined && !Number.isFinite(amount)) return res.status(400).json({ message: 'Enter a refund amount' });
    return res.json({ payment: await payments.refundRide(req.params.id, { amount, fromDriver: req.body.fromDriver === true, reason: req.body.reason }) });
  } catch (error) { return fail(res, error, 'Unable to refund'); }
});

/** Which outside services have keys set, and Plate Recognizer's monthly usage. Names only, never key values. */
router.get('/providers', protect, only('admin'), async (_req, res) => {
  try {
    return res.json({
      payments: { enabled: payments.enabled(), testMode: payments.enabled() ? payments.testMode() : null, webhook: !!process.env.STRIPE_WEBHOOK_SECRET, connectWebhook: !!process.env.STRIPE_CONNECT_WEBHOOK_SECRET },
      identity: { enabled: identity.isReady(), webhook: !!process.env.STRIPE_IDENTITY_WEBHOOK_SECRET },
      plateReader: { enabled: plateReader.isReady(), region: process.env.PLATE_RECOGNIZER_REGION || null, usage: await plateReader.usage() },
      faceMatch: { enabled: faceMatch.isReady() },
      backgroundCheck: { mode: backgroundCheck.mode() }
    });
  } catch (error) { return fail(res, error, 'Unable to load providers'); }
});

module.exports = router;
