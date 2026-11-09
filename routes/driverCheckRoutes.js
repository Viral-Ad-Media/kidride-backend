const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { sendError } = require('../lib/http');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const checks = require('../lib/driverChecks');
const { RULES, CHECK_KINDS } = require('../lib/reverification');
const { timingSafeEqual } = require('node:crypto');
const { loadSafety } = require('../lib/safetySettings');
const { normalizeSafety, DEFAULT_SAFETY } = require('../lib/safety');
const backgroundCheck = require('../lib/backgroundCheck');

const settings = async () => { try { return await loadSafety(); } catch { return normalizeSafety(DEFAULT_SAFETY); } };

// Driver verification: identity (provider), face checks with random actions,
// and live photos of the car, plate, licence or current location.
const router = express.Router();
const admin = express.Router();

const FRONTEND_URL = (process.env.FRONTEND_URLS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)[0] || 'http://localhost:3001';
const requireDriver = (req, res, next) => (req.user.role === 'driver' ? next() : res.status(403).json({ message: 'Driver account required' }));
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ message: 'Admin required' }));
const fail = (res, error, fallback) => (error.status && error.status < 500 ? res.status(error.status).json({ message: error.message }) : sendError(res, error, fallback));
const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, message: 'Too many verification requests. Try again later.', keyPrefix: 'driver-check', keyGenerator: (req) => req.user?.id });

router.get('/', protect, requireDriver, async (req, res) => {
  try {
    const [identity, list] = await Promise.all([checks.identityState(req.user.id), checks.listForDriver(req.user.id)]);
    const { sessionId, ...publicIdentity } = identity;
    return res.json({ identity: publicIdentity, background: { mode: backgroundCheck.mode() }, checks: list, blocked: list.some((check) => check.blocksDriving) });
  } catch (error) { return fail(res, error, 'Unable to load verification'); }
});

router.post('/identity/start', protect, requireDriver, limiter, async (req, res) => {
  try {
    const { providerReady, status } = await checks.identityState(req.user.id);
    if (!providerReady) return res.status(409).json({ message: 'ID verification is not switched on yet. Complete the face and licence checks instead.' });
    if (status === 'verified' && !(await checks.listForDriver(req.user.id)).some((c) => c.kind === 'identity' && c.status === 'pending')) return res.status(409).json({ message: 'Your identity is already verified' });
    return res.json({ url: await checks.startIdentity(req.user, `${FRONTEND_URL}/#/driver-verification`) });
  } catch (error) { return fail(res, error, 'Unable to start ID verification'); }
});

router.post('/identity/refresh', protect, requireDriver, async (req, res) => {
  try { const { sessionId, ...state } = await checks.refreshIdentity(req.user.id); return res.json(state); }
  catch (error) { return fail(res, error, 'Unable to check ID verification'); }
});

router.post('/background/start', protect, requireDriver, limiter, async (req, res) => {
  try { return res.json(await checks.startBackground(req.user)); }
  catch (error) { return fail(res, error, 'Unable to start the background check'); }
});

// Daily job (Vercel Cron, CRON_SECRET): licence and insurance expiry reminders.
router.get('/cron/daily', async (req, res) => {
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  const actual = String(req.get('authorization') || '');
  if (!process.env.CRON_SECRET || actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return res.status(401).json({ message: 'Not authorized' });
  try { return res.json(await checks.runDaily(await settings())); }
  catch (error) { return fail(res, error, 'Daily verification job failed'); }
});

router.post('/:id/start', protect, requireDriver, limiter, async (req, res) => {
  try { return res.json(await checks.startCheck(req.user.id, req.params.id)); }
  catch (error) { return fail(res, error, 'Unable to start the check'); }
});

router.post('/:id/upload-url', protect, requireDriver, limiter, async (req, res) => {
  try { return res.json(await checks.uploadUrl(req.user.id, req.params.id, req.body.slot, req.body.contentType)); }
  catch (error) { return fail(res, error, 'Photo upload unavailable'); }
});

router.post('/:id/submit', protect, requireDriver, async (req, res) => {
  try { return res.json(await checks.submitCheck(req.user.id, req.params.id, req.body, await settings())); }
  catch (error) { return fail(res, error, 'Unable to send the check'); }
});

// Admin console Verification page.
admin.get('/rules', protect, requireAdmin, (_req, res) => res.json({ rules: Object.entries(RULES).map(([reason, rule]) => ({ reason, ...rule })), kinds: CHECK_KINDS }));

admin.get('/checks', protect, requireAdmin, async (req, res) => {
  const status = ['submitted', 'open', 'all'].includes(req.query.status) ? req.query.status : 'submitted';
  try { return res.json({ checks: await checks.listForAdmin(status) }); }
  catch (error) { return fail(res, error, 'Unable to load checks'); }
});

admin.get('/checks/:id', protect, requireAdmin, async (req, res) => {
  try { return res.json(await checks.detailForAdmin(req.params.id)); }
  catch (error) { return fail(res, error, 'Check unavailable'); }
});

admin.put('/checks/:id/review', protect, requireAdmin, async (req, res) => {
  if (!['passed', 'failed', 'cancelled'].includes(req.body.result)) return res.status(400).json({ message: 'Choose passed, failed or cancelled' });
  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
  try { return res.json(await checks.review(req.params.id, req.user.id, req.body.result, note)); }
  catch (error) { return fail(res, error, 'Unable to save the review'); }
});

admin.post('/request', protect, requireAdmin, async (req, res) => {
  const kinds = Array.isArray(req.body.kinds) ? req.body.kinds.filter((kind) => CHECK_KINDS.includes(kind)) : [];
  if (typeof req.body.driverId !== 'string' || !kinds.length) return res.status(400).json({ message: 'Choose a driver and at least one check' });
  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
  try {
    const created = await checks.flag(req.body.driverId, 'admin_request', { requestedBy: req.user.id, kinds, note });
    return res.status(201).json({ checks: created });
  } catch (error) { return fail(res, error, 'Unable to request the check'); }
});

module.exports = { router, admin };
