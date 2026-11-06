// Startup review of configuration. Required variables are enforced by
// config/db.js; this only warns about production settings that are missing or
// weak, by name, in the server log. Values are never logged.
const RECOMMENDED_IN_PRODUCTION = [
  ['FRONTEND_URLS', 'browsers from the live site are blocked by CORS'],
  ['CRON_SECRET', 'scheduled jobs cannot authenticate'],
  ['GOOGLE_ROUTES_API_KEY', 'every fare quote falls back to the minimum fare'],
  ['RESEND_API_KEY', 'ride emails are not sent'],
  ['SENTRY_DSN', 'server errors are only in the Vercel log']
];

const isProduction = () => process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';

const reviewEnvironment = (env = process.env) => {
  const warnings = [];
  const production = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
  const jwtSecret = env.JWT_SECRET?.trim() || '';
  if (jwtSecret && jwtSecret.length < 32) warnings.push('JWT_SECRET is shorter than 32 characters; use a long random value');
  if (production) {
    for (const [name, effect] of RECOMMENDED_IN_PRODUCTION) {
      if (!env[name]?.trim()) warnings.push(`${name} is not set: ${effect}`);
    }
    const origins = (env.FRONTEND_URLS || '').split(',').map(origin => origin.trim()).filter(Boolean);
    if (origins.some(origin => origin.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      warnings.push('FRONTEND_URLS contains a non-HTTPS origin');
    }
    if (env.NODE_ENV !== 'production') warnings.push('NODE_ENV is not "production": rate limits use per-instance memory');
  }
  return warnings;
};

const logEnvironmentWarnings = () => {
  for (const warning of reviewEnvironment()) console.warn(`[config] ${warning}`);
};

module.exports = { reviewEnvironment, logEnvironmentWarnings, isProduction };
