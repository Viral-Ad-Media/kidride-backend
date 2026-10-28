const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { sendError } = require('../lib/http');
const { loadSafety, saveSafety, safetyUpdatedAt } = require('../lib/safetySettings');
const { DEFAULT_SAFETY } = require('../lib/safety');

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

module.exports = router;
