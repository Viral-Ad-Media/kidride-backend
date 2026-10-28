const { DEFAULT_SAFETY, normalizeSafety } = require('./safety');
const { createSettingsStore } = require('./settingsStore');

// The single safety_settings row the admin edits (alert thresholds).
const store = createSettingsStore('safety_settings', DEFAULT_SAFETY, normalizeSafety, 'Safety settings');

module.exports = { loadSafety: store.load, saveSafety: store.save, safetyUpdatedAt: store.updatedAt };
