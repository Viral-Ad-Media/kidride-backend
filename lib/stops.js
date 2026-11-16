// Extra stops on a ride: the car goes pickup -> stop 1 -> ... -> drop-off. Each stop
// can name the children who get out there (one school, then a club). Stops live in
// rides.stops and ride_series.stops (jsonb, from multi_stop.sql). Until that SQL has
// run, rides without stops work as before and a booking with stops is refused.
const { parsePlaceCoords, isSamePlace } = require('./security');

const MAX_STOPS = 3;
const MAX_ADDRESS = 200;
const MAX_NOTE = 120;
const UNAVAILABLE_MESSAGE = 'Rides with extra stops are not switched on yet. Book without stops for now.';
const STOP_SAME_PLACE_MESSAGE = 'Two places next to each other on this route are the same. Remove the duplicate stop.';
const invalid = (message) => ({ error: message });

/**
 * Validates the stops a parent entered. raw: [{ address, coords: { lat, lng }, note?, childIds? }].
 * Every stop needs a picked place (coords) so the whole route can be priced.
 * Returns { stops } or { error }.
 */
// childIds: the ride's children, which a stop may name; null (quotes) ignores names.
const parseStops = (raw, { childIds = null } = {}) => {
  if (raw == null) return { stops: [] };
  if (!Array.isArray(raw)) return invalid('Stops must be a list');
  if (raw.length > MAX_STOPS) return invalid(`A ride can have up to ${MAX_STOPS} extra stops`);
  const allowed = childIds ? new Set(childIds) : null;
  const stops = [];
  for (const [index, item] of raw.entries()) {
    const label = `Stop ${index + 1}`;
    if (!item || typeof item !== 'object') return invalid(`${label} is not valid`);
    const address = typeof item.address === 'string' ? item.address.trim() : '';
    if (!address) return invalid(`${label} needs an address`);
    if (address.length > MAX_ADDRESS) return invalid(`${label}: address is too long`);
    const coords = parsePlaceCoords(item.coords);
    if (!coords) return invalid(`${label}: choose the address from the suggestions so we can price the route`);
    const note = typeof item.note === 'string' ? item.note.trim().slice(0, MAX_NOTE) : '';
    const ids = allowed && Array.isArray(item.childIds) ? [...new Set(item.childIds)] : [];
    if (ids.some((id) => typeof id !== 'string' || !allowed.has(id))) return invalid(`${label}: choose children who are on this ride`);
    stops.push({ address, coords, note: note || null, childIds: ids });
  }
  return { stops };
};

/** Pickup, stops and drop-off in order: no two neighbours may be the same place. */
const routeHasRepeat = (pickup, stops, dropoff) => {
  const points = [pickup, ...stops, dropoff];
  return points.slice(1).some((point, i) => isSamePlace(points[i].address, point.address, points[i].coords, point.coords));
};

/** Stops as stored on a new ride: every one still to do. */
const freshStops = (stops) => (stops || []).map((stop) => ({
  address: stop.address, coords: stop.coords, note: stop.note || null, childIds: stop.childIds || [],
  status: 'pending', arrivedAt: null, completedAt: null
}));

/** The stop the car is heading to (or waiting at), or -1 when every stop is done. */
const nextStopIndex = (stops) => (stops || []).findIndex((stop) => stop.status !== 'done');
const pendingStops = (stops) => (stops || []).filter((stop) => stop.status !== 'done').length;

const formatStops = (stops) => (Array.isArray(stops) ? stops : []).map((stop, index) => ({
  index,
  address: stop.address,
  coords: stop.coords || null,
  note: stop.note || null,
  childIds: stop.childIds || [],
  status: stop.status || 'pending',
  arrivedAt: stop.arrivedAt || null,
  completedAt: stop.completedAt || null
}));

/** Part of the signed quote: the same pickup and drop-off with other stops is another trip. */
const stopsKey = (stops) => (stops || []).map((stop) => [stop.coords.lat, stop.coords.lng]);

/**
 * The driver arrives at, or finishes, the next stop. Stops are done in order while the
 * children are in the car. Returns { stops, stop } or { error, status }.
 */
const advanceStop = (ride, index, action, now = new Date()) => {
  const stops = Array.isArray(ride.stops) ? ride.stops : [];
  if (ride.status !== 'child_picked_up') return { error: 'Stops start once the children are in the car', status: 409 };
  if (!Number.isInteger(index) || !stops[index]) return { error: 'Stop not found', status: 404 };
  const next = nextStopIndex(stops);
  if (index !== next) return { error: next === -1 ? 'Every stop is already done' : `Finish stop ${next + 1} first`, status: 409 };
  const stop = stops[index];
  const at = now.toISOString();
  let updated;
  if (action === 'arrive') {
    if (stop.status === 'arrived') return { error: 'Already marked as arrived', status: 409 };
    updated = { ...stop, status: 'arrived', arrivedAt: at };
  } else if (action === 'complete') {
    updated = { ...stop, status: 'done', arrivedAt: stop.arrivedAt || at, completedAt: at };
  } else {
    return { error: 'action must be arrive or complete', status: 400 };
  }
  return { stops: stops.map((item, i) => (i === index ? updated : item)), stop: { ...updated, index } };
};

// Whether the live database has the stops columns. Checked once per server start, and
// again every few minutes while missing, so running the SQL takes effect without a restart.
const RECHECK_MS = 5 * 60 * 1000;
let support = null;
let checkedAt = 0;
const detectSupport = () => {
  if (support && !known.rides && Date.now() - checkedAt > RECHECK_MS) support = null;
  if (!support) {
    checkedAt = Date.now();
    const { supabaseAdmin } = require('../config/supabase');
    support = Promise.all([
      supabaseAdmin.from('rides').select('stops').limit(0),
      supabaseAdmin.from('ride_series').select('stops').limit(0)
    ]).then(([rides, series]) => ({ rides: !rides.error, series: !series.error }))
      .catch(() => { support = null; return { rides: false, series: false }; });
  }
  return support;
};
let known = { rides: false, series: false };
/** Express middleware: makes sure the support check has finished before ride queries build their select. */
const ensureSupport = async (_req, _res, next) => {
  try { known = await detectSupport(); } catch { /* keep the last answer */ }
  next();
};
const ridesHaveStops = () => known.rides;
const seriesHaveStops = () => known.series;
const setSupportForTests = (value) => { known = value; support = Promise.resolve(value); };

module.exports = {
  MAX_STOPS, UNAVAILABLE_MESSAGE, STOP_SAME_PLACE_MESSAGE,
  parseStops, routeHasRepeat, freshStops, nextStopIndex, pendingStops, formatStops, stopsKey, advanceStop,
  ensureSupport, ridesHaveStops, seriesHaveStops, setSupportForTests
};
