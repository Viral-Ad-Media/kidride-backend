const { createClient } = require('@supabase/supabase-js');

const getRequiredEnv = (name) => {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
};

const url = getRequiredEnv('SUPABASE_URL');
const anonKey = getRequiredEnv('SUPABASE_ANON_KEY');
const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const sharedOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
};

const supabaseAuth = createClient(url, anonKey, sharedOptions);
const supabaseAdmin = createClient(url, serviceRoleKey, sharedOptions);

module.exports = {
  supabaseAuth,
  supabaseAdmin
};
