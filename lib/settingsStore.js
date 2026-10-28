const { supabaseAdmin } = require('../config/supabase');

// A single-row settings table the admin edits (pricing_settings, safety_settings).
// Cached briefly so every request does not hit the database; saving clears the cache.
const CACHE_MS = 30 * 1000;

const createSettingsStore = (table, defaults, normalize, label) => {
  let cached = null;
  const load = async () => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.settings;
    const { data, error } = await supabaseAdmin.from(table).select('settings, updated_at').eq('id', 1).maybeSingle();
    if (error) throw Object.assign(new Error(`${label} is temporarily unavailable.`), { status: 503, cause: error });
    const settings = normalize(data?.settings || defaults);
    cached = { at: Date.now(), settings, updatedAt: data?.updated_at || null };
    return settings;
  };
  const updatedAt = () => cached?.updatedAt || null;
  const save = async (input, adminId) => {
    const settings = normalize(input);
    const { data, error } = await supabaseAdmin.from(table)
      .upsert({ id: 1, settings, updated_by: adminId, updated_at: new Date().toISOString() })
      .select('updated_at').single();
    if (error) throw error;
    cached = { at: Date.now(), settings, updatedAt: data.updated_at };
    return settings;
  };
  return { load, save, updatedAt };
};

module.exports = { createSettingsStore };
