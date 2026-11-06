const crypto = require('crypto');

// Private live-location links for an SOS. The link carries a random token; the
// database keeps only its SHA-256, so a leaked table never yields working links.
// Anyone with the link sees the child's first name, the driver's first name and
// car, the ride status and the car's latest position, until the link expires or
// support marks the incident handled.

const SHARE_HOURS = 12;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const makeShareToken = (now = new Date()) => {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, hash: hashToken(token), expiresAt: new Date(now.getTime() + SHARE_HOURS * 3600 * 1000).toISOString() };
};

const isTokenShaped = (token) => typeof token === 'string' && TOKEN_PATTERN.test(token);

const firstName = (name) => (name || '').trim().split(/\s+/)[0] || '';

/** What the public page may show. Returns null when the link no longer works. */
const publicSosView = ({ incident, ride, childName }, now = new Date()) => {
  if (!incident || !ride || incident.kind !== 'sos') return null;
  if (incident.resolved_at) return { active: false, reason: 'handled' };
  if (!incident.share_expires_at || new Date(incident.share_expires_at) <= now) return { active: false, reason: 'expired' };
  const vehicle = ride.driver?.vehicle || {};
  const live = ride.driver_location && !['completed', 'cancelled'].includes(ride.status) ? ride.driver_location : null;
  const raised = incident.location || null;
  const point = (p) => (p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
    ? { latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy ?? null, recordedAt: p.recordedAt || null }
    : null);
  return {
    active: true,
    child: firstName(childName) || 'The child',
    driver: firstName(ride.driver?.name) || null,
    vehicle: [vehicle.color, vehicle.make, vehicle.model].filter(Boolean).join(' ') || null,
    plate: vehicle.plate || vehicle.licensePlate || null,
    status: ride.status,
    pickup: ride.pickup_location,
    dropoff: ride.dropoff_location,
    raisedBy: incident.reporter_role === 'driver' ? 'driver' : incident.reporter_role === 'parent' ? 'parent' : 'someone',
    raisedAt: incident.created_at,
    location: point(live) || point(raised),
    expiresAt: incident.share_expires_at
  };
};

const mapsLink = (location) => (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)
  ? `https://www.google.com/maps?q=${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`
  : null);

module.exports = { SHARE_HOURS, hashToken, makeShareToken, isTokenShaped, publicSosView, mapsLink };
