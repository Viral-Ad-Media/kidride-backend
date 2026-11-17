// Address search for the mobile apps, through the server. A Google key cannot
// be shipped inside a phone app the way the website's key is (that key only
// answers for the website's own addresses), so the apps ask this API and the
// key stays on the server. Google Places API (New), same as the website uses.

const BASE = 'https://places.googleapis.com/v1';
const TIMEOUT_MS = 6000;

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

// Server keys to try, in order. Either needs "Places API (New)" allowed in Google Cloud:
// GOOGLE_PLACES_API_KEY if a separate key is wanted, else the key already used for fares.
const candidates = () => ['GOOGLE_PLACES_API_KEY', 'GOOGLE_ROUTES_API_KEY']
  .map((name) => (process.env[name] || '').trim())
  .filter(Boolean);

// The key Google last accepted, so a refused one is not retried on every keystroke.
let working = null;

const call = async (path, init, fetchImpl) => {
  const keys = candidates();
  if (!keys.length) throw fail(503, 'Address search is not set up on the server.', 'places_unavailable');
  let denied = null;
  for (const key of (working && keys.includes(working) ? [working, ...keys.filter((other) => other !== working)] : keys)) {
    const response = await fetchImpl(`${BASE}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), 'X-Goog-Api-Key': key },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (response.ok) {
      working = key;
      return response.json();
    }
    // This key is not allowed to use Places: try the next one.
    if (response.status === 403) {
      denied = (await response.json().catch(() => null))?.error?.message || 'Permission denied';
      if (working === key) working = null;
      continue;
    }
    if (response.status === 404) throw fail(404, 'That place could not be found.');
    if (response.status === 400) throw fail(400, 'That address could not be searched. Try different words.');
    throw fail(502, 'Address search is unavailable right now.');
  }
  console.warn('Address search: no server key is allowed to use Places API (New).', denied);
  throw fail(503, 'Address search is not set up on the server.', 'places_unavailable');
};

const validPoint = (point) => !!point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
  && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;

/** Suggestions for what the person has typed so far: [{ placeId, title, subtitle, text }]. */
const suggest = async ({ input, sessionToken, near }, { fetchImpl = fetch } = {}) => {
  const body = { input, sessionToken };
  // Prefer places within 50 km of where the person is, without excluding the rest.
  if (validPoint(near)) body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50000 } };
  const data = await call('/places:autocomplete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, fetchImpl);
  return (data.suggestions || [])
    .map((item) => item.placePrediction)
    .filter((prediction) => prediction && prediction.placeId)
    .slice(0, 5)
    .map((prediction) => {
      const text = prediction.text?.text || '';
      return {
        placeId: prediction.placeId,
        title: prediction.structuredFormat?.mainText?.text || text,
        subtitle: prediction.structuredFormat?.secondaryText?.text || '',
        text
      };
    });
};

/** The address and exact position of a picked suggestion: { address, coords: { lat, lng } }. */
const resolve = async ({ placeId, sessionToken }, { fetchImpl = fetch } = {}) => {
  const query = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : '';
  const data = await call(`/places/${encodeURIComponent(placeId)}${query}`, { headers: { 'X-Goog-FieldMask': 'formattedAddress,location' } }, fetchImpl);
  const lat = Number(data.location?.latitude);
  const lng = Number(data.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw fail(502, 'Google did not return a position for this place.');
  return { address: data.formattedAddress || '', coords: { lat, lng } };
};

/** Forgets which key worked (tests, or after the keys change). */
const reset = () => { working = null; };

module.exports = { suggest, resolve, reset, validPoint };
