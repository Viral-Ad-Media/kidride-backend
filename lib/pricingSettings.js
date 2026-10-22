const { DEFAULT_PRICING, normalizeSettings } = require('./pricing');
const { createSettingsStore } = require('./settingsStore');

// The single pricing_settings row the admin edits.
const store = createSettingsStore('pricing_settings', DEFAULT_PRICING, normalizeSettings, 'Pricing');

module.exports = { loadPricing: store.load, savePricing: store.save, pricingUpdatedAt: store.updatedAt };
