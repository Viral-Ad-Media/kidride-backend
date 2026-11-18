// Driving distance and time for a fare quote. Uses the Google Routes API when
// GOOGLE_ROUTES_API_KEY is set (server key, no referrer restriction); otherwise,
// or if Google fails, a straight-line estimate: haversine x ROAD_FACTOR at ESTIMATE_MPH.

const METERS_PER_MILE = 1609.344;
const ROAD_FACTOR = 1.3;
const ESTIMATE_MPH = 22;
const ROUTES_TIMEOUT_MS = 5000;

const haversineMiles = (a, b) => {
  const rad = (deg) => deg * Math.PI / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h)) / METERS_PER_MILE;
};

const estimateMetrics = (pickup, dropoff) => {
  const miles = haversineMiles(pickup, dropoff) * ROAD_FACTOR;
  return { miles, minutes: Math.ceil(miles / ESTIMATE_MPH * 60), source: 'estimate' };
};

const routesMetrics = async (pickup, dropoff, key, fetchImpl = fetch) => {
  const point = ({ lat, lng }) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
  const response = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
    body: JSON.stringify({ origin: point(pickup), destination: point(dropoff), travelMode: 'DRIVE' }),
    signal: AbortSignal.timeout(ROUTES_TIMEOUT_MS)
  });
  const route = (await response.json())?.routes?.[0];
  const seconds = parseFloat(route?.duration);
  if (!response.ok || !Number.isFinite(route?.distanceMeters) || !Number.isFinite(seconds)) throw new Error('No driving route');
  return { miles: route.distanceMeters / METERS_PER_MILE, minutes: Math.ceil(seconds / 60), source: 'routes' };
};

const tripMetrics = async (pickup, dropoff, { fetchImpl } = {}) => {
  const key = process.env.GOOGLE_ROUTES_API_KEY;
  if (key) {
    try { return await routesMetrics(pickup, dropoff, key, fetchImpl); } catch (error) { console.warn('Routes API failed; using straight-line estimate', error.message); }
  }
  return estimateMetrics(pickup, dropoff);
};

/**
 * How much slower than usual the drive to the drop-off is right now (1 = no traffic),
 * from Google Routes TRAFFIC_AWARE duration vs static duration. 1 without a key or on error.
 */
const trafficFactor = async (from, to, { fetchImpl = fetch } = {}) => {
  const key = process.env.GOOGLE_ROUTES_API_KEY;
  if (!key) return 1;
  try {
    const point = ({ lat, lng }) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
    const response = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.duration,routes.staticDuration' },
      body: JSON.stringify({ origin: point(from), destination: point(to), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' }),
      signal: AbortSignal.timeout(ROUTES_TIMEOUT_MS)
    });
    const route = (await response.json())?.routes?.[0];
    const live = parseFloat(route?.duration);
    const usual = parseFloat(route?.staticDuration);
    return response.ok && live > 0 && usual > 0 ? Math.round((live / usual) * 100) / 100 : 1;
  } catch { return 1; }
};

// The turns of a route, for the driver's in-app directions.
const STEP_FIELDS = 'routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction,routes.legs.steps.startLocation,routes.legs.steps.endLocation';
const MAX_STEPS = 200;
const stepPoint = (location) => {
  const point = location?.latLng;
  return point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) ? { lat: point.latitude, lng: point.longitude } : null;
};
const routeSteps = (route) => (route?.legs || []).flatMap((leg) => leg?.steps || []).slice(0, MAX_STEPS).map((step) => {
  const start = stepPoint(step?.startLocation);
  const end = stepPoint(step?.endLocation);
  if (!start || !end) return null;
  return {
    // Google adds lines such as "Destination will be on the right": the first line is the turn itself.
    instruction: String(step.navigationInstruction?.instructions || '').split('\n')[0].trim().slice(0, 160),
    maneuver: String(step.navigationInstruction?.maneuver || '').toLowerCase().slice(0, 40),
    meters: Number(step.distanceMeters) || 0,
    start,
    end
  };
}).filter(Boolean);

/**
 * The driving route between two points for the apps' maps: Google's encoded
 * line, the driving time in seconds and the length in metres. The apps cannot
 * hold a Google key themselves, so they ask the API for this. Default routing
 * (no live traffic) keeps it on the cheapest Routes tier, as for fares.
 * Throws with `status` and a `code`: 'routes_unavailable' (no usable key) or 'no_route'.
 *
 * With `steps` it also returns the turns in order, for the driver's in-app
 * directions: what to do ("Turn left onto Oak Street"), the kind of turn, how
 * long the stretch is and where it starts and ends.
 */
const drivingRoute = async (from, to, { fetchImpl = fetch, steps = false } = {}) => {
  const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
  const key = process.env.GOOGLE_ROUTES_API_KEY;
  if (!key) throw fail(503, 'Routes are not set up on the server.', 'routes_unavailable');
  const point = ({ lat, lng }) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
  const response = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': `routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline${steps ? `,${STEP_FIELDS}` : ''}` },
    body: JSON.stringify({ origin: point(from), destination: point(to), travelMode: 'DRIVE' }),
    signal: AbortSignal.timeout(ROUTES_TIMEOUT_MS)
  });
  if (response.status === 403) throw fail(503, 'Routes are not set up on the server.', 'routes_unavailable');
  if (!response.ok) throw fail(502, 'The route could not be loaded right now.');
  const route = (await response.json())?.routes?.[0];
  const polyline = route?.polyline?.encodedPolyline;
  const seconds = parseFloat(route?.duration);
  if (typeof polyline !== 'string' || !polyline || !Number.isFinite(seconds)) throw fail(404, 'No driving route between those points.', 'no_route');
  const found = { polyline, seconds: Math.round(seconds), meters: Number(route.distanceMeters) || 0 };
  return steps ? { ...found, steps: routeSteps(route) } : found;
};

module.exports = { tripMetrics, estimateMetrics, haversineMiles, trafficFactor, drivingRoute };
