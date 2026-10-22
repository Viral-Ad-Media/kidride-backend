const { supabaseAdmin } = require('../config/supabase');
const { DEFAULT_PRICING, normalizeSettings } = require('./pricing');

// The single pricing_settings row the admin edits. Cached briefly so every
// quote does not hit the database; saving clears the cache.
const CACHE_MS = 30 * 1000;
let cached = null;

const loadPricing = async () => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.settings;
  const { data, error } = await supabaseAdmin.from('pricing_settings').select('settings, updated_at').eq('id', 1).maybeSingle();
  if (error) throw Object.assign(new Error('Pricing is temporarily unavailable.'), { status: 503, cause: error });
  const settings = normalizeSettings(data?.settings || DEFAULT_PRICING);
  cached = { at: Date.now(), settings, updatedAt: data?.updated_at || null };
  return settings;
};

const pricingUpdatedAt = () => cached?.updatedAt || null;

const savePricing = async (input, adminId) => {
  const settings = normalizeSettings(input);
  const { data, error } = await supabaseAdmin.from('pricing_settings')
    .upsert({ id: 1, settings, updated_by: adminId, updated_at: new Date().toISOString() })
    .select('updated_at').single();
  if (error) throw error;
  cached = { at: Date.now(), settings, updatedAt: data.updated_at };
  return settings;
};

module.exports = { loadPricing, savePricing, pricingUpdatedAt };
