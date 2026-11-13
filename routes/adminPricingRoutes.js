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

// Monthly family plans: tiers, the profit guard, and how many parents are on each.
const subscriptions = require('../lib/subscriptions');
router.get('/plans', protect, requireAdmin, async (_req, res) => {
  try {
    const [settings, summary] = await Promise.all([subscriptions.loadPlans(), subscriptions.subscriberSummary().catch(() => null)]);
    return res.json({ settings, defaults: subscriptions.DEFAULT_SETTINGS, updatedAt: subscriptions.plansUpdatedAt(), summary });
  } catch (error) { return sendError(res, error, 'Unable to load plans'); }
});
router.put('/plans', protect, requireAdmin, async (req, res) => {
  try { return res.json({ settings: await subscriptions.savePlans(req.body.settings, req.user.id), updatedAt: subscriptions.plansUpdatedAt() }); }
  catch (error) { return sendError(res, error, 'Unable to save plans'); }
});
// Body: { settings, miles, minutes, localTime } -> per plan, the discount on a pickup and on a pickup+drop-off ride.
router.post('/plans/preview', protect, requireAdmin, async (req, res) => {
  try {
    const plans = subscriptions.normalizeSettings(req.body.settings);
    const pricing = await loadPricing();
    const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(req.body.localTime || '') || [null, '10', '00'];
    const trip = { miles: Number(req.body.miles) || 0, minutes: Number(req.body.minutes) || 0, localMinutes: Number(time[1]) * 60 + Number(time[2]) };
    const out = plans.plans.map((plan) => {
      const terms = { ...plan, minProfitPerRide: plans.minProfitPerRide, cardFeePercent: plans.cardFeePercent, cardFeeFixed: plans.cardFeeFixed };
      const row = (serviceType) => {
        const fare = computeFare(pricing, { ...trip, serviceType });
        const { amount } = subscriptions.rideDiscount(terms, fare);
        const kidride = fare.total - amount - fare.driverEarnings - ((fare.total - amount) * plans.cardFeePercent / 100 + plans.cardFeeFixed);
        return { fare: fare.total, discount: amount, parentPays: Math.round((fare.total - amount) * 100) / 100, driverEarns: fare.driverEarnings, kidrideKeeps: Math.round(kidride * 100) / 100 };
      };
      return { id: plan.id, pickup: row('pickup_only'), pickupAndDropoff: row('pickup_and_dropoff') };
    });
    return res.json({ currency: pricing.currency, plans: out });
  } catch (error) { return sendError(res, error, 'Unable to preview plans'); }
});

module.exports = router;
