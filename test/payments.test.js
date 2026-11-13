const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const stripeApi = require('../lib/stripeApi');
const payments = require('../lib/payments');
const plateReader = require('../lib/plateReader');

test('payments stay off until both Stripe keys are set, and can be switched off', () => {
  const saved = { ...process.env };
  delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_PUBLISHABLE_KEY; delete process.env.PAYMENTS_ENABLED;
  assert.equal(payments.enabled(), false);
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
  assert.equal(payments.enabled(), false);
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_abc';
  assert.equal(payments.enabled(), true);
  assert.equal(payments.testMode(), true);
  process.env.PAYMENTS_ENABLED = 'false';
  assert.equal(payments.enabled(), false);
  process.env = saved;
});

test('booking needs no card while payments are off', async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  await payments.requireCard('parent-1');
  assert.equal(await payments.authorizeRide({ id: 'r', price: 20 }), null);
  assert.equal(await payments.settleRide({ id: 'r', price: 20 }, { amount: 20, driverAmount: 16, purpose: 'ride_fare' }), null);
  if (saved) process.env.STRIPE_SECRET_KEY = saved;
});

test('amounts convert to the smallest currency unit', () => {
  assert.equal(stripeApi.toMinor(23.45, 'USD'), 2345);
  assert.equal(stripeApi.toMinor(19.999, 'gbp'), 2000);
  assert.equal(stripeApi.toMinor(1500, 'JPY'), 1500);
  assert.equal(stripeApi.fromMinor(2345, 'usd'), 23.45);
});

test('webhook signatures are checked against any configured secret', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
  const t = Math.floor(Date.now() / 1000);
  const sign = (secret) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  assert.equal(stripeApi.verifyEvent(body, sign('whsec_b'), ['whsec_a', 'whsec_b']).id, 'evt_1');
  assert.throws(() => stripeApi.verifyEvent(body, sign('whsec_x'), ['whsec_a']), /Bad signature/);
  assert.throws(() => stripeApi.verifyEvent(body, sign('whsec_a'), [undefined]), /secret not set/);
});

test('form encoding nests objects and arrays the way Stripe expects', () => {
  const encoded = stripeApi.encode({ amount: 100, metadata: { ride_id: 'r1' }, payment_method_types: ['card'] }).toString();
  assert.equal(decodeURIComponent(encoded), 'amount=100&metadata[ride_id]=r1&payment_method_types[]=card');
});

test('plate reader: free-plan rate limit gets one retry; used-up quota falls back to admin review', async () => {
  const savedFetch = global.fetch;
  process.env.PLATE_RECOGNIZER_TOKEN = 'token';
  const statuses = [429, 200];
  global.fetch = async () => {
    const status = statuses.shift();
    return { status, ok: status === 200, json: async () => ({ results: [{ plate: 'abc123', score: 0.91 }] }) };
  };
  assert.deepEqual(await plateReader.readPlate(new Blob(['x'])), { plate: 'ABC123', score: 0.91 });
  global.fetch = async () => ({ status: 403, ok: false, json: async () => ({}) });
  await assert.rejects(plateReader.readPlate(new Blob(['x'])), (error) => error.code === 'quota_used');
  await assert.rejects(plateReader.readPlate({ size: 4 * 1024 * 1024 }), (error) => error.code === 'too_large');
  global.fetch = savedFetch;
  delete process.env.PLATE_RECOGNIZER_TOKEN;
});
