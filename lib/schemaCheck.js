// Checks that the live database has the tables and columns this code reads.
// A missing column (as with driver_checks.due_at) used to fail silently inside
// dispatch and verification; now it is logged and sent to Sentry on the first
// request after a cold start, and /api/health/ready reports it.
const { captureError } = require('./monitoring');

const REQUIRED = {
  profiles: ['id', 'role', 'is_blocked', 'token_version', 'driver_application_status', 'last_online_at', 'last_active_at', 'known_devices', 'identity_status', 'identity_verified_at', 'last_spot_check_at'],
  driver_applications: ['driver_id', 'documents', 'submitted_at', 'reviewed_at', 'review_note', 'license_expires_on', 'insurance_expires_on', 'document_reviews'],
  driver_checks: ['id', 'driver_id', 'kind', 'reason', 'clears', 'status', 'details', 'challenge', 'evidence', 'due_at', 'reviewed_at'],
  driver_flags: ['id', 'driver_id', 'reason', 'created_at'],
  driver_locations: ['driver_id', 'lat', 'lng', 'h3_index', 'updated_at'],
  rides: ['id', 'parent_id', 'driver_id', 'status', 'is_scheduled', 'dispatch_state', 'child_ids'],
  ride_offers: ['ride_id', 'driver_id'],
  password_resets: ['token_hash', 'user_id', 'expires_at', 'used_at']
};

const checkSchema = async () => {
  const { supabaseAdmin } = require('../config/supabase');
  const problems = [];
  await Promise.all(Object.entries(REQUIRED).map(async ([table, columns]) => {
    const { error } = await supabaseAdmin.from(table).select(columns.join(',')).limit(0);
    if (error) problems.push(`${table}: ${error.message}`);
  }));
  return problems.sort();
};

let started = null;
const checkOnce = (_req, _res, next) => {
  if (!started) {
    started = checkSchema().then((problems) => {
      if (problems.length) {
        const message = `Database schema is behind the code. Run the pending SQL. ${problems.join(' | ')}`;
        console.error(`[schema] ${message}`);
        captureError(new Error(message), { route: 'schema-check' });
      }
      return problems;
    }).catch((error) => { console.warn('[schema] check unavailable', error.message); started = null; return null; });
  }
  next();
};

module.exports = { REQUIRED, checkSchema, checkOnce };
