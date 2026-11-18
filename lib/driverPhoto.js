// The driver's face photo for the parent of their ride. The photo is the
// front-facing one from the driver's approved application, kept in the private
// verification bucket, so the parent gets a link that works for an hour rather
// than a public address.

// Loaded when first used, so reading this file never needs database settings (tests load the ride routes without them).
const database = () => require('../config/supabase').supabaseAdmin;
const bucket = () => require('./verification').BUCKET;

const LINK_SECONDS = 60 * 60;
// A parent's app asks for the trip every few seconds: reuse a link until it is 50 minutes old.
const REUSE_MS = 50 * 60 * 1000;
const MAX_REMEMBERED = 500;
const links = new Map();

/** A time-limited link to the driver's face photo, or null when there is none. */
const driverPhotoUrl = async (driverId) => {
  const known = links.get(driverId);
  if (known && known.until > Date.now()) return known.url;
  const { data, error } = await database().from('driver_applications').select('documents').eq('driver_id', driverId).maybeSingle();
  if (error) throw error;
  const path = data?.documents?.photo_front;
  if (typeof path !== 'string' || !path) return null;
  const { data: signed, error: signError } = await database().storage.from(bucket()).createSignedUrl(path, LINK_SECONDS);
  if (signError) throw signError;
  const url = signed?.signedUrl || null;
  if (url) {
    if (links.size >= MAX_REMEMBERED) links.delete(links.keys().next().value);
    links.set(driverId, { url, until: Date.now() + REUSE_MS });
  }
  return url;
};

module.exports = { driverPhotoUrl };
