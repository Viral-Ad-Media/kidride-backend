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

module.exports = { tripMetrics, estimateMetrics, haversineMiles };
