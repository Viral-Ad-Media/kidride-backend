const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { sendError } = require('../lib/http');
const { loadSafety, saveSafety, safetyUpdatedAt } = require('../lib/safetySettings');
const { DEFAULT_SAFETY } = require('../lib/safety');
const { listAllIncidents } = require('../lib/incidents');
const INCIDENT_KINDS = new Set(['sos', 'trip_code', 'off_route', 'stalled']);

// Admin console Safety page: read and change the alert thresholds.
const router = express.Router();
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ message: 'Admin required' }));

router.get('/', protect, requireAdmin, async (req, res) => {
  try { return res.json({ settings: await loadSafety(), defaults: DEFAULT_SAFETY, updatedAt: safetyUpdatedAt() }); }
  catch (error) { return sendError(res, error, 'Unable to load safety settings'); }
});

router.put('/', protect, requireAdmin, async (req, res) => {
  try { return res.json({ settings: await saveSafety(req.body.settings, req.user.id), updatedAt: safetyUpdatedAt() }); }
  catch (error) { return sendError(res, error, 'Unable to save safety settings'); }
});

// Incident history (and the open SOS feed the admin alarm polls).
router.get('/incidents', protect, requireAdmin, async (req, res) => {
  const status = req.query.status === 'all' ? 'all' : 'open';
  const kind = INCIDENT_KINDS.has(req.query.kind) ? req.query.kind : null;
  try { return res.json({ incidents: await listAllIncidents({ status, kind, limit: req.query.limit }) }); }
  catch (error) { return sendError(res, error, 'Unable to load incidents'); }
});

module.exports = router;
