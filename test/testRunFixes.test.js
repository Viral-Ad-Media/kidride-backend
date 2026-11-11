const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { accountKey, isTrackingRequest } = require('../middleware/rateLimitMiddleware');
const { isSamePlace } = require('../lib/security');

test('rate limit keys signed-in requests by account, others by IP', () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  const token = jwt.sign({ id: 'user-1', tv: 0 }, process.env.JWT_SECRET);
  assert.equal(accountKey({ headers: { authorization: `Bearer ${token}` } }), 'user:user-1');
  assert.equal(accountKey({ headers: { authorization: 'Bearer forged.token.value' } }), null);
  assert.equal(accountKey({ headers: {} }), null);
});

test('trip GPS and the driver heartbeat use the tracking limit', () => {
  assert.equal(isTrackingRequest({ method: 'PUT', path: '/rides/abc/location' }), true);
  assert.equal(isTrackingRequest({ method: 'PUT', path: '/users/me/presence' }), true);
  assert.equal(isTrackingRequest({ method: 'GET', path: '/rides/active' }), false);
  assert.equal(isTrackingRequest({ method: 'PUT', path: '/rides/abc/status' }), false);
});

test('pickup and drop-off at the same place are refused', () => {
  assert.equal(isSamePlace('12 Main St', '12 main st.', null, null), true);
  assert.equal(isSamePlace('Home', 'School', { lat: 40.75, lng: -73.98 }, { lat: 40.7505, lng: -73.9805 }), true);
  assert.equal(isSamePlace('Home', 'School', { lat: 40.75, lng: -73.98 }, { lat: 40.76, lng: -73.97 }), false);
  assert.equal(isSamePlace('Home', 'School', null, null), false);
});
