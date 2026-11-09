// Driver re-verification rules. Pure functions only: the database side is in
// lib/driverChecks.js. An unusual event (a reason) maps to the checks the driver
// must complete before taking new rides. A check never interrupts a ride in progress.

// What the driver is asked to do.
//   identity        ID document + live selfie matched by the identity provider (Stripe Identity)
//   liveness        live face check with random actions (turn, open mouth, nod...)
//   id_document     live photo of the driving licence (used when no identity provider is set up)
//   vehicle_photo   live photo of the registered car
//   plate_photo     live photo of the licence plate
//   location_photo  live photo of where the driver is now, with GPS
const CHECK_KINDS = ['identity', 'liveness', 'id_document', 'vehicle_photo', 'plate_photo', 'location_photo'];
const PHOTO_KINDS = ['id_document', 'vehicle_photo', 'plate_photo', 'location_photo'];

// How a check is cleared once the driver has done it:
//   submit    driving unlocks on submission; an admin reviews it afterwards
//   review    driving stays locked until an admin passes it
//   provider  the identity provider's result decides
const RULES = Object.freeze({
  onboarding: { label: 'New driver', checks: ['identity', 'liveness'], clears: 'review' },
  overshoot: { label: 'Drove past the drop-off with the child onboard', checks: ['liveness', 'location_photo'], clears: 'review' },
  gps_jump: { label: 'Impossible GPS jump (possible location spoofing)', checks: ['liveness', 'location_photo'], clears: 'review' },
  trip_code_locked: { label: 'Too many wrong trip codes at a pickup', checks: ['identity'], clears: 'review' },
  parent_sos: { label: 'Parent pressed SOS', checks: ['identity', 'vehicle_photo', 'plate_photo'], clears: 'review' },
  frequent_stops: {
    label: 'Many stops on one trip outside the pickup and drop-off', checks: ['liveness'], clears: 'submit',
    repeat: { count: 2, days: 30, checks: ['liveness', 'vehicle_photo'], clears: 'review' }
  },
  off_route: { label: 'Off route again within 30 days', checks: [], repeat: { count: 2, days: 30, checks: ['liveness', 'location_photo'], clears: 'submit' } },
  stalled: { label: 'Stopped with the child onboard, 3 times in 30 days', checks: [], repeat: { count: 3, days: 30, checks: ['liveness'], clears: 'submit' } },
  low_rating: {
    label: 'Rated 1 or 2 stars', checks: ['liveness'], clears: 'submit',
    repeat: { count: 2, days: 30, checks: ['identity', 'vehicle_photo'], clears: 'review' }
  },
  inactivity: { label: 'Back after a long time offline', checks: ['liveness'], clears: 'submit' },
  identity_renewal: { label: 'Yearly identity renewal', checks: ['identity'], clears: 'provider' },
  spot_check: { label: 'Random spot check', checks: ['liveness', 'plate_photo'], clears: 'submit' },
  admin_request: { label: 'Requested by KidRide support', checks: [], clears: 'review' }
});

/**
 * The checks to request for one event. recentCount is how many times this reason
 * happened for the driver in the rule's repeat window, including this one.
 * Returns { checks, clears, repeated } or null when nothing is needed.
 */
const planChecks = (reason, recentCount = 1) => {
  const rule = RULES[reason];
  if (!rule) return null;
  if (rule.repeat && recentCount >= rule.repeat.count) return { checks: [...rule.repeat.checks], clears: rule.repeat.clears, repeated: true };
  return rule.checks.length ? { checks: [...rule.checks], clears: rule.clears, repeated: false } : null;
};

/** Without an identity provider, an identity check becomes a live licence photo plus a face check, reviewed by an admin. */
const expandForProvider = (plan, providerReady) => {
  if (!plan || providerReady || !plan.checks.includes('identity')) return plan;
  const checks = [...new Set(plan.checks.flatMap((kind) => (kind === 'identity' ? ['id_document', 'liveness'] : [kind])))];
  return { ...plan, checks, clears: 'review' };
};

// Random face actions for a liveness check. Three different ones, in random order.
const LIVENESS_ACTIONS = ['turn_left', 'turn_right', 'open_mouth', 'nod', 'blink', 'smile'];
const pickActions = (random = Math.random, count = 3) => {
  const pool = [...LIVENESS_ACTIONS];
  const picked = [];
  while (picked.length < count && pool.length) picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return picked;
};

/**
 * Which reason, if any, applies when a driver goes online.
 * driver: { lastOnlineAt, identityVerifiedAt, lastSpotCheckAt, approvedAt }.
 */
const onlineReason = (settings, driver, now = new Date(), random = Math.random) => {
  const daysSince = (iso) => (iso ? (now - new Date(iso)) / 86400000 : Infinity);
  if (driver.identityVerifiedAt && daysSince(driver.identityVerifiedAt) > settings.identityRenewDays) return 'identity_renewal';
  if (driver.lastOnlineAt && daysSince(driver.lastOnlineAt) > settings.inactivityDays) return 'inactivity';
  if (daysSince(driver.lastSpotCheckAt) >= settings.spotCheckMinDays && random() * 100 < settings.spotCheckPercent) return 'spot_check';
  return null;
};

/** Metres between two { lat, lng } points (haversine). */
const metersBetween = (a, b) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

/** Whether this check, in this status, stops the driver taking new rides. */
const blocksDriving = (check) => check.status === 'pending' || check.status === 'failed' || (check.status === 'submitted' && check.clears !== 'submit');

module.exports = { CHECK_KINDS, PHOTO_KINDS, RULES, LIVENESS_ACTIONS, planChecks, expandForProvider, pickActions, onlineReason, metersBetween, blocksDriving };
