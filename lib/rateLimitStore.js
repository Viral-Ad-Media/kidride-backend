const { createHash } = require('node:crypto');
const { supabaseAdmin } = require('../config/supabase');
const consume = async (key, windowMs) => {
  const { data, error } = await supabaseAdmin.rpc('consume_rate_limit', { bucket_key: createHash('sha256').update(key).digest('hex'), duration_ms: windowMs });
  if (error) throw error;
  return Number(data);
};
module.exports = { consume };
