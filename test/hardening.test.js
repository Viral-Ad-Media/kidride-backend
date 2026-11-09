const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { reviewEnvironment } = require('../lib/envCheck');
const monitoring = require('../lib/monitoring');

test('environment review flags weak and missing production settings by name only', () => {
  const warnings = reviewEnvironment({ NODE_ENV: 'production', JWT_SECRET: 'tiny-s3cr3t', FRONTEND_URLS: 'http://kid-ride.example' });
  assert.ok(warnings.some(w => w.startsWith('JWT_SECRET')));
  assert.ok(warnings.some(w => w.startsWith('CRON_SECRET')));
  assert.ok(warnings.some(w => w.includes('non-HTTPS')));
  assert.ok(!warnings.join(' ').includes('tiny-s3cr3t'));
  assert.deepEqual(reviewEnvironment({ NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(40) }), []);
});

test('monitoring is a no-op without SENTRY_DSN', async () => {
  delete process.env.SENTRY_DSN;
  assert.equal(monitoring.initMonitoring(), false);
  monitoring.captureError(new Error('ignored'));
  assert.equal(await monitoring.flushMonitoring(), true);
});

test('responses carry request id and security headers; CORS rejects unknown origins with 403', async () => {
  process.env.FRONTEND_URLS = 'https://kid-ride.vercel.app';
  const app = require('../server');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const get = (headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/health', headers }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ res, body }));
    }).on('error', reject);
  });
  try {
    const ok = await get({ Origin: 'https://kid-ride.vercel.app' });
    assert.equal(ok.res.statusCode, 200);
    assert.match(ok.res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.equal(ok.res.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.res.headers['x-powered-by'], undefined);
    const blocked = await get({ Origin: 'https://evil.example' });
    assert.equal(blocked.res.statusCode, 403);
    assert.doesNotMatch(blocked.body, /Error|stack/);
  } finally { server.close(); }
});
