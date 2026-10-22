// Ride safety rules. Pure functions only: thresholds come from
// lib/safetySettings.js (the admin-edited safety_settings row).
const { timingSafeEqual } = require('node:crypto');
const { haversineMiles } = require('./routeMetrics');

const DEFAULT_SAFETY = Object.freeze({
  // Wrong trip codes before the pickup locks and only support can move the ride on.
  tripCodeMaxAttempts: 5,
  // How far the car may be from the straight pickup-to-drop-off line before it is off route.
  offRouteMiles: 1.5,
  // Stopped (within stalledRadiusMeters) for this long with the child onboard.
  stalledMinutes: 5,
  stalledRadiusMeters: 100,
  // No stalled alerts this close to the drop-off: the car is parking.
  dropoffQuietMeters: 300
});

const METERS_PER_MILE = 1609.344;
// Most serious first; a ride shows its most serious open incident.
const ALERT_PRIORITY = { sos: 4, trip_code: 3, off_route: 2, stalled: 1 };
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const bounded = (value, name, min, max, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw invalid(`${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
  return value;
};

/** Merges stored values over the defaults and rejects anything malformed. */
const normalizeSafety = (input = {}) => {
  const raw = { ...DEFAULT_SAFETY, ...input };
  return {
    tripCodeMaxAttempts: bounded(raw.tripCodeMaxAttempts, 'Trip code attempts', 1, 20, true),
    offRouteMiles: bounded(raw.offRouteMiles, 'Off-route distance', 0.1, 50),
    stalledMinutes: bounded(raw.stalledMinutes, 'Stalled minutes', 1, 120, true),
    stalledRadiusMeters: bounded(raw.stalledRadiusMeters, 'Stalled radius', 10, 2000, true),
    dropoffQuietMeters: bounded(raw.dropoffQuietMeters, 'Drop-off quiet zone', 0, 5000, true)
  };
};

/** Compares an entered trip code with the ride's in constant time; spaces are ignored. */
const tripCodeMatches = (entered, actual) => {
  const a = Buffer.from(String(entered ?? '').replace(/\s+/g, ''));
  const b = Buffer.from(String(actual ?? ''));
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

/** Miles from point p to the segment a-b ({ lat, lng }), on a local flat projection (fine at city scale). */
const milesFromSegment = (p, a, b) => {
  const kx = Math.cos((a.lat * Math.PI) / 180);
  const x = (pt) => (pt.lng - a.lng) * kx;
  const y = (pt) => pt.lat - a.lat;
  const dx = x(b), dy = y(b);
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (x(p) * dx + y(p) * dy) / lengthSq));
  return haversineMiles(p, { lat: a.lat + t * dy, lng: a.lng + (t * dx) / kx });
};

/**
 * Checks one GPS fix during a trip with the child onboard.
 * ride: { status, pickup_coords, dropoff_coords, monitor }; position: { lat, lng }.
 * Returns { monitor, alerts: [{ kind, details }] }. Each alert fires once until the car
 * is back on route (off_route) or moves again (stalled).
 */
const evaluatePosition = (settings, ride, position, now = new Date()) => {
  const previous = ride.monitor && typeof ride.monitor === 'object' ? ride.monitor : {};
  if (ride.status !== 'child_picked_up') return { monitor: previous, alerts: [] };
  const alerts = [];
  const monitor = { ...previous };
  const at = now.toISOString();

  const { pickup_coords: pickup, dropoff_coords: dropoff } = ride;
  if (pickup && dropoff) {
    const off = milesFromSegment(position, pickup, dropoff);
    if (!monitor.offRoute && off > settings.offRouteMiles) {
      monitor.offRoute = true;
      alerts.push({ kind: 'off_route', details: { milesFromRoute: Math.round(off * 10) / 10, thresholdMiles: settings.offRouteMiles } });
    } else if (monitor.offRoute && off <= settings.offRouteMiles / 2) {
      monitor.offRoute = false;
    }
  }

  const anchor = monitor.anchor;
  const movedMeters = anchor ? haversineMiles(anchor, position) * METERS_PER_MILE : Infinity;
  if (movedMeters > settings.stalledRadiusMeters) {
    monitor.anchor = { lat: position.lat, lng: position.lng, since: at };
    monitor.stalled = false;
  } else if (!monitor.stalled) {
    const stoppedMinutes = (now - new Date(anchor.since)) / 60000;
    const nearDropoff = dropoff && haversineMiles(position, dropoff) * METERS_PER_MILE <= settings.dropoffQuietMeters;
    if (stoppedMinutes >= settings.stalledMinutes && !nearDropoff) {
      monitor.stalled = true;
      alerts.push({ kind: 'stalled', details: { stoppedMinutes: Math.floor(stoppedMinutes), thresholdMinutes: settings.stalledMinutes } });
    }
  }
  return { monitor, alerts };
};

/** Whether a new alert should replace the ride's current flag. */
const outranks = (kind, current) => !current || (ALERT_PRIORITY[kind] || 0) >= (ALERT_PRIORITY[current] || 0);

/**
 * When the driver may record a no-show and what it costs, from the fare engine's
 * cancellation rules. ride: { status, arrived_at, price }.
 */
const noShowTerms = (pricing, ride, now = new Date()) => {
  const rules = pricing.cancellation;
  const fee = Math.min(rules.noShowFee, Number(ride.price) || 0);
  if (ride.status !== 'driver_arrived_at_pickup' || !ride.arrived_at) return { allowed: false, availableAt: null, fee };
  const availableAt = new Date(new Date(ride.arrived_at).getTime() + rules.noShowWaitMinutes * 60000);
  return { allowed: now >= availableAt, availableAt: availableAt.toISOString(), fee };
};

module.exports = { DEFAULT_SAFETY, ALERT_PRIORITY, normalizeSafety, tripCodeMatches, milesFromSegment, evaluatePosition, outranks, noShowTerms };
