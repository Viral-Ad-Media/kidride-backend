const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET'
];

// Validate without terminating a serverless worker during module import.
const connectDB = () => {
  const missing = REQUIRED_ENV_VARS.filter(name => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  let url;
  try { url = new URL(process.env.SUPABASE_URL.trim()); } catch { throw new Error('SUPABASE_URL must be a valid HTTP(S) URL'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('SUPABASE_URL must be a valid HTTP(S) URL');
};
module.exports = connectDB;
