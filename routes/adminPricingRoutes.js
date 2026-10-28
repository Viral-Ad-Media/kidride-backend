const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { sendError } = require('../lib/http');
const { loadPricing, savePricing, pricingUpdatedAt } = require('../lib/pricingSettings');
const { DEFAULT_PRICING, SERVICE_TYPES, normalizeSettings, computeFare } = require('../lib/pricing');

// Admin console Pricing page: read and change the fare rates, and preview a
// sample trip with unsaved rates before saving.
const router = express.Router();
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ message: 'Admin required' }));

router.get('/', protect, requireAdmin, async (req, res) => {
  try { return res.json({ settings: await loadPricing(), defaults: DEFAULT_PRICING, updatedAt: pricingUpdatedAt() }); }
  catch (error) { return sendError(res, error, 'Unable to load pricing'); }
});

router.put('/', protect, requireAdmin, async (req, res) => {
  try { return res.json({ settings: await savePricing(req.body.settings, req.user.id), updatedAt: pricingUpdatedAt() }); }
  catch (error) { return sendError(res, error, 'Unable to save pricing'); }
});

// Body: { settings, miles, minutes, localTime ('HH:MM' in the pricing time zone), stayMinutes? } -> a fare per service type.
router.post('/preview', protect, requireAdmin, (req, res) => {
  try {
    const settings = normalizeSettings(req.body.settings);
    const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(req.body.localTime || '');
    if (!time) return res.status(400).json({ message: 'Invalid sample time' });
    const trip = { miles: Number(req.body.miles) || 0, minutes: Number(req.body.minutes) || 0, stayMinutes: Number(req.body.stayMinutes) || 60, localMinutes: Number(time[1]) * 60 + Number(time[2]) };
    return res.json({ quotes: Object.fromEntries(SERVICE_TYPES.map((serviceType) => [serviceType, computeFare(settings, { ...trip, serviceType })])) });
  } catch (error) { return sendError(res, error, 'Unable to preview pricing'); }
});

module.exports = router;
