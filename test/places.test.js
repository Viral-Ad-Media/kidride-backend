const test = require('node:test');
const assert = require('node:assert/strict');
const places = require('../lib/places');

const KEYS = ['GOOGLE_PLACES_API_KEY', 'GOOGLE_ROUTES_API_KEY', 'VITE_GOOGLE_MAPS_KEY', 'FRONTEND_URLS'];

// Runs `work` with only the given Google settings, then puts the real ones back.
const withEnv = async (values, work) => {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  places.reset();
  try { return await work(); } finally {
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    places.reset();
  }
};

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const prediction = { placePrediction: { placeId: 'ChIJ-place-1234', text: { text: '1 Main St, Denver, CO, USA' }, structuredFormat: { mainText: { text: '1 Main St' }, secondaryText: { text: 'Denver, CO, USA' } } } };

test('suggest maps Google predictions and biases toward the given point', async () => {
  await withEnv({ GOOGLE_PLACES_API_KEY: 'server-key' }, async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return json(200, { suggestions: [prediction, { queryPrediction: {} }] }); };
    const found = await places.suggest({ input: '1 Main', sessionToken: 'session-12345', near: { lat: 39.7, lng: -104.9 } }, { fetchImpl });
    assert.deepEqual(found, [{ placeId: 'ChIJ-place-1234', title: '1 Main St', subtitle: 'Denver, CO, USA', text: '1 Main St, Denver, CO, USA' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'server-key');
    assert.equal(calls[0].init.headers.Referer, undefined);
    assert.equal(JSON.parse(calls[0].init.body).locationBias.circle.center.latitude, 39.7);
  });
});

test('a key Google refuses is skipped, and the one that works is remembered', async () => {
  await withEnv({ GOOGLE_PLACES_API_KEY: 'not-allowed', GOOGLE_ROUTES_API_KEY: 'server-key' }, async () => {
    const used = [];
    const fetchImpl = async (_url, init) => {
      used.push(init.headers['X-Goog-Api-Key']);
      return init.headers['X-Goog-Api-Key'] === 'not-allowed' ? json(403, { error: { message: 'Permission denied' } }) : json(200, { suggestions: [prediction] });
    };
    await places.suggest({ input: '1 Main' }, { fetchImpl });
    await places.suggest({ input: '1 Main St' }, { fetchImpl });
    assert.deepEqual(used, ['not-allowed', 'server-key', 'server-key']);
  });
});

test('the website key is never used for the apps', async () => {
  await withEnv({ VITE_GOOGLE_MAPS_KEY: 'site-key', FRONTEND_URLS: 'https://kidride.example' }, async () => {
    let called = false;
    await assert.rejects(places.suggest({ input: '1 Main' }, { fetchImpl: async () => { called = true; return json(200, {}); } }), { status: 503, code: 'places_unavailable' });
    assert.equal(called, false);
  });
});

test('no usable key answers 503 places_unavailable', async () => {
  await withEnv({}, async () => {
    await assert.rejects(places.suggest({ input: '1 Main' }, { fetchImpl: async () => json(200, {}) }), { status: 503, code: 'places_unavailable' });
  });
  await withEnv({ GOOGLE_ROUTES_API_KEY: 'routes-only' }, async () => {
    await assert.rejects(places.suggest({ input: '1 Main' }, { fetchImpl: async () => json(403, { error: { message: 'Permission denied' } }) }), { status: 503, code: 'places_unavailable' });
  });
});

test('resolve returns the address and position, and rejects a place without one', async () => {
  await withEnv({ GOOGLE_PLACES_API_KEY: 'server-key' }, async () => {
    const good = async (url, init) => {
      assert.match(url, /\/places\/ChIJ-place-1234\?sessionToken=session-12345$/);
      assert.equal(init.headers['X-Goog-FieldMask'], 'formattedAddress,location');
      return json(200, { formattedAddress: '1 Main St, Denver, CO 80202, USA', location: { latitude: 39.75, longitude: -104.99 } });
    };
    assert.deepEqual(await places.resolve({ placeId: 'ChIJ-place-1234', sessionToken: 'session-12345' }, { fetchImpl: good }), { address: '1 Main St, Denver, CO 80202, USA', coords: { lat: 39.75, lng: -104.99 } });
    await assert.rejects(places.resolve({ placeId: 'ChIJ-place-1234' }, { fetchImpl: async () => json(200, { formattedAddress: 'Somewhere' }) }), { status: 502 });
  });
});

const { drivingRoute } = require('../lib/routeMetrics');

test('drivingRoute returns the line, seconds and metres', async () => {
  await withEnv({ GOOGLE_ROUTES_API_KEY: 'server-key' }, async () => {
    const fetchImpl = async (url, init) => {
      assert.equal(url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
      assert.match(init.headers['X-Goog-FieldMask'], /routes\.polyline\.encodedPolyline/);
      assert.deepEqual(JSON.parse(init.body).origin, { location: { latLng: { latitude: 39.7, longitude: -104.9 } } });
      return json(200, { routes: [{ distanceMeters: 772, duration: '165s', polyline: { encodedPolyline: 'ipkcFfichVnP@j@BLoFVwM{E?' } }] });
    };
    assert.deepEqual(await drivingRoute({ lat: 39.7, lng: -104.9 }, { lat: 39.8, lng: -105 }, { fetchImpl }), { polyline: 'ipkcFfichVnP@j@BLoFVwM{E?', seconds: 165, meters: 772 });
  });
});

test('drivingRoute says when routes are not set up or there is no route', async () => {
  const from = { lat: 39.7, lng: -104.9 };
  const to = { lat: 39.8, lng: -105 };
  await withEnv({}, async () => {
    await assert.rejects(drivingRoute(from, to, { fetchImpl: async () => json(200, {}) }), { status: 503, code: 'routes_unavailable' });
  });
  await withEnv({ GOOGLE_ROUTES_API_KEY: 'server-key' }, async () => {
    await assert.rejects(drivingRoute(from, to, { fetchImpl: async () => json(403, {}) }), { status: 503, code: 'routes_unavailable' });
    await assert.rejects(drivingRoute(from, to, { fetchImpl: async () => json(200, { routes: [] }) }), { status: 404, code: 'no_route' });
  });
});
