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
  dropoffQuietMeters: 300,
  // Drove past the drop-off: got this close to it, then this far away again, child still onboard.
  overshootNearMeters: 150,
  overshootMeters: 800,
  // A stop of at least stopSeconds away from the pickup and drop-off counts toward
  // frequent stops; two minutes leaves out ordinary traffic lights.
  stopSeconds: 120,
  maxStopsPerTrip: 4,
  // Faster than this between two fixes means the reported position cannot be real.
  maxSpeedKph: 200,
  // Running late: the trip with the child onboard has taken lateFactor x the expected
  // drive time and at least lateMinMinutes more than expected. Tells the parent once.
  lateFactor: 1.5,
  lateMinMinutes: 5,
  // Re-verification when a driver goes online.
  spotCheckPercent: 5,
  spotCheckMinDays: 7,
  inactivityDays: 30,
  identityRenewDays: 365,
  farLoginKm: 100,
  // Ask for a new licence or insurance photo this many days before it expires.
  documentReminderDays: 14,
  // Face matching: similarity (0-100) needed to pass automatically.
  faceMatchThreshold: 90
});

const METERS_PER_MILE = 1609.344;
// Without a quoted drive time: roads are ~1.3x the straight line, at ~25 mph in town.
const estimateMinutes = (pickup, dropoff) => (pickup && dropoff ? Math.max(5, Math.round((haversineMiles(pickup, dropoff) * 1.3 / 25) * 60)) : 0);
// Most serious first; a ride shows its most serious open incident.
const ALERT_PRIORITY = { sos: 7, trip_code: 6, gps_jump: 5, overshoot: 4, off_route: 3, stalled: 2, frequent_stops: 1 };
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
    dropoffQuietMeters: bounded(raw.dropoffQuietMeters, 'Drop-off quiet zone', 0, 5000, true),
    overshootNearMeters: bounded(raw.overshootNearMeters, 'Drop-off reached distance', 20, 2000, true),
    overshootMeters: bounded(raw.overshootMeters, 'Drove-past distance', 100, 20000, true),
    stopSeconds: bounded(raw.stopSeconds, 'Stop length', 30, 1800, true),
    maxStopsPerTrip: bounded(raw.maxStopsPerTrip, 'Stops per trip', 1, 50, true),
    maxSpeedKph: bounded(raw.maxSpeedKph, 'Top believable speed', 60, 1000, true),
    lateFactor: bounded(raw.lateFactor, 'Running late factor', 1.1, 5),
    lateMinMinutes: bounded(raw.lateMinMinutes, 'Running late minimum', 1, 120, true),
    spotCheckPercent: bounded(raw.spotCheckPercent, 'Spot check chance', 0, 100),
    spotCheckMinDays: bounded(raw.spotCheckMinDays, 'Days between spot checks', 0, 365, true),
    inactivityDays: bounded(raw.inactivityDays, 'Inactive days', 1, 3650, true),
    identityRenewDays: bounded(raw.identityRenewDays, 'Identity renewal days', 30, 3650, true),
    farLoginKm: bounded(raw.farLoginKm, 'Far-away distance', 5, 5000, true),
    documentReminderDays: bounded(raw.documentReminderDays, 'Document reminder days', 1, 90, true),
    faceMatchThreshold: bounded(raw.faceMatchThreshold, 'Face match threshold', 70, 99, true)
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

  const metersTo = (point) => (point ? haversineMiles(position, point) * METERS_PER_MILE : Infinity);
  const nearEnds = (point) => Math.min(
    pickup ? haversineMiles(point, pickup) * METERS_PER_MILE : Infinity,
    dropoff ? haversineMiles(point, dropoff) * METERS_PER_MILE : Infinity
  ) <= settings.dropoffQuietMeters;

  // Impossible movement between two fixes: a spoofed or replayed location.
  const last = monitor.lastFix;
  if (last && !monitor.gpsJump) {
    const hours = (now - new Date(last.at)) / 3600000;
    const km = haversineMiles(last, position) * 1.609344;
    if (hours > 0 && km > 0.5 && km / hours > settings.maxSpeedKph) {
      monitor.gpsJump = true;
      alerts.push({ kind: 'gps_jump', details: { kph: Math.round(km / hours), km: Math.round(km * 10) / 10, seconds: Math.round(hours * 3600) } });
    }
  }
  monitor.lastFix = { lat: position.lat, lng: position.lng, at };

  // Running late: compares time since the first fix with the child onboard against the
  // quoted drive time (or an estimate). Not a safety incident: the parent is told once.
  if (!monitor.tripStartedAt) monitor.tripStartedAt = at;
  if (monitor.expectedMinutes === undefined) {
    const quoted = Math.round(Number(ride.fare_breakdown?.minutes) || 0);
    monitor.expectedMinutes = quoted > 0 && ride.fare_breakdown?.distanceSource !== 'none' ? quoted : estimateMinutes(pickup, dropoff);
  }
  if (!monitor.late && monitor.expectedMinutes > 0) {
    const elapsed = (now - new Date(monitor.tripStartedAt)) / 60000;
    const limit = Math.max(monitor.expectedMinutes * settings.lateFactor, monitor.expectedMinutes + settings.lateMinMinutes);
    if (elapsed >= limit && !(dropoff && metersTo(dropoff) <= settings.overshootNearMeters)) {
      monitor.late = true;
      alerts.push({ kind: 'running_late', details: { elapsedMinutes: Math.floor(elapsed), expectedMinutes: monitor.expectedMinutes, minutesLeft: dropoff ? estimateMinutes(position, dropoff) : null } });
    }
  }

  // Drove past the drop-off: came within reach of it, then went well beyond with the child onboard.
  if (dropoff) {
    const toDropoff = metersTo(dropoff);
    monitor.closestDropoffMeters = Math.round(Math.min(monitor.closestDropoffMeters ?? Infinity, toDropoff));
    if (!monitor.overshoot && monitor.closestDropoffMeters <= settings.overshootNearMeters && toDropoff >= settings.overshootMeters) {
      monitor.overshoot = true;
      alerts.push({ kind: 'overshoot', details: { metersPastDropoff: Math.round(toDropoff), closestMeters: monitor.closestDropoffMeters } });
    }
  }

  const anchor = monitor.anchor;
  const movedMeters = anchor ? haversineMiles(anchor, position) * METERS_PER_MILE : Infinity;
  if (movedMeters > settings.stalledRadiusMeters) {
    // Leaving a spot: count it as a stop when it lasted long enough away from the pickup and drop-off.
    if (anchor && (now - new Date(anchor.since)) / 1000 >= settings.stopSeconds && !nearEnds(anchor)) {
      monitor.stops = (monitor.stops || 0) + 1;
      // Heavy traffic on the route (Google Routes, measured at pickup) allows proportionally more stops.
      const stopLimit = Math.round(settings.maxStopsPerTrip * Math.min(3, Math.max(1, Number(monitor.trafficFactor) || 1)));
      if (monitor.stops >= stopLimit && !monitor.frequentStops) {
        monitor.frequentStops = true;
        alerts.push({ kind: 'frequent_stops', details: { stops: monitor.stops, limit: stopLimit, minSeconds: settings.stopSeconds, trafficFactor: monitor.trafficFactor || 1 } });
      }
    }
    monitor.anchor = { lat: position.lat, lng: position.lng, since: at };
    monitor.stalled = false;
  } else if (!monitor.stalled) {
    const stoppedMinutes = (now - new Date(anchor.since)) / 60000;
    const nearDropoff = metersTo(dropoff) <= settings.dropoffQuietMeters;
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

module.exports = { DEFAULT_SAFETY, estimateMinutes, ALERT_PRIORITY, normalizeSafety, tripCodeMatches, milesFromSegment, evaluatePosition, outranks, noShowTerms };
