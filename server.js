const dotenv = require('dotenv');
dotenv.config({ quiet: true });
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const { createRateLimiter, parsePositiveInt } = require('./middleware/rateLimitMiddleware');
const { requestContext } = require('./middleware/requestContext');
const { initMonitoring, captureError, flushMonitoring } = require('./lib/monitoring');
const { logEnvironmentWarnings, isProduction } = require('./lib/envCheck');

initMonitoring();
logEnvironmentWarnings();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || (process.env.VERCEL ? 1 : 0)));
// Production never falls back to localhost origins.
const defaultOrigins = isProduction() ? 'https://kid-ride.vercel.app' : 'http://localhost:3001,http://localhost:3000,http://localhost:5173';
const allowedOrigins = (process.env.FRONTEND_URLS || defaultOrigins)
  .split(',').map(origin => origin.trim().replace(/\/+$/, '')).filter(Boolean);
app.use(requestContext);
app.use(cors({
  origin: (origin, callback) => !origin || allowedOrigins.includes(origin)
    ? callback(null, true) : callback(Object.assign(new Error('Origin not allowed'), { status: 403 })),
  credentials: true,
  maxAge: 600
}));
// Stripe Identity webhook: needs the raw body to check the signature, so it runs before the JSON parser.
app.post('/api/webhooks/stripe-identity', express.raw({ type: 'application/json', limit: '200kb' }), async (req, res) => {
  try {
    const { parseWebhook } = require('./lib/identityProvider');
    const result = parseWebhook(req.body.toString('utf8'), req.get('stripe-signature'));
    if (result?.driverId) await require('./lib/driverChecks').applyIdentityResult(result.driverId, result);
    return res.json({ received: true });
  } catch (error) {
    if (error.status >= 500 || !error.status) console.error('Identity webhook failed', error.message);
    return res.status(error.status && error.status < 500 ? error.status : 500).json({ message: 'Webhook rejected' });
  }
});
// Checkr background check results (same raw-body rule as above).
app.post('/api/webhooks/checkr', express.raw({ type: 'application/json', limit: '200kb' }), async (req, res) => {
  try {
    const result = require('./lib/backgroundCheck').parseCheckrWebhook(req.body.toString('utf8'), req.get('x-checkr-signature'));
    if (result?.candidateId) await require('./lib/driverChecks').applyBackgroundResult(result);
    return res.json({ received: true });
  } catch (error) {
    if (error.status >= 500 || !error.status) console.error('Checkr webhook failed', error.message);
    return res.status(error.status && error.status < 500 ? error.status : 500).json({ message: 'Webhook rejected' });
  }
});
app.use(express.json({ limit: '100kb' }));
// Express 5 leaves req.body undefined when no JSON body was parsed.
app.use((req, _res, next) => { if (req.body === undefined) req.body = {}; next(); });

// Load all API dependencies atomically. Missing config must not kill the function.
let apiRouter;
try {
  connectDB();
  const router = express.Router();
  // Signed-in requests are counted per account, so a household, office or mobile
  // carrier sharing one IP cannot use up each other's allowance. Trip GPS and the
  // driver heartbeat skip this limit and have their own per-account limit, so
  // safety monitoring never loses location updates to busy polling.
  const { accountKey, isTrackingRequest } = require('./middleware/rateLimitMiddleware');
  const globalLimiter = createRateLimiter({
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: parsePositiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 1000),
    message: 'Too many requests. Please try again later.', keyPrefix: 'global',
    keyGenerator: accountKey
  });
  const trackingLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: parsePositiveInt(process.env.TRACKING_RATE_LIMIT_MAX_REQUESTS, 1800),
    message: 'Too many location updates. Please try again shortly.', keyPrefix: 'tracking',
    keyGenerator: accountKey
  });
  router.use((req, res, next) => (isTrackingRequest(req) ? trackingLimiter : globalLimiter)(req, res, next));
  // First request after a cold start checks the live database has every column the code needs.
  router.use(require('./lib/schemaCheck').checkOnce);
  router.use('/auth', require('./routes/authRoutes'));
  router.use('/account', require('./routes/accountRoutes'));
  router.use('/users/me/trusted-contacts', require('./routes/trustedContactRoutes'));
  router.use('/users', require('./routes/adminUserRoutes'));
  router.use('/users', require('./routes/userRoutes'));
  router.use('/drivers', require('./routes/driverRoutes'));
  const driverChecks = require('./routes/driverCheckRoutes');
  router.use('/driver-checks', driverChecks.router);
  router.use('/admin/verification', driverChecks.admin);
  router.use('/admin/live-map', require('./routes/adminLiveRoutes'));
  router.use('/admin/pricing', require('./routes/adminPricingRoutes'));
  router.use('/admin/safety', require('./routes/adminSafetyRoutes'));
  router.use('/rides', require('./routes/rideRoutes'));
  router.use('/ride-series', require('./routes/seriesRoutes'));
  router.use('/safety-chat', require('./routes/safetyRoutes'));
  router.use('/notification-receipts', require('./routes/receiptRoutes'));
  router.use('/notifications', require('./routes/notificationRoutes'));
  apiRouter = router;
} catch (error) {
  // Variable names and stack traces belong in runtime logs, never HTTP responses.
  console.error('KidRide API initialization failed:', error);
}

const status = (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(apiRouter ? 200 : 503).json({
    service: 'KidRide API', status: apiRouter ? 'configured' : 'unavailable',
    database: 'not_checked'
  });
};
app.get('/', status);
app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ status: 'alive' }));
app.get('/api/health', status);
// Readiness for uptime monitors: one cheap database read, cached for 30 seconds
// so the public endpoint cannot be used to load the database.
let readiness = { at: 0, ok: false };
let schemaProblems = null;
app.get('/api/health/ready', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!apiRouter) return res.status(503).json({ status: 'unavailable', database: 'not_checked' });
  if (Date.now() - readiness.at > 30000) {
    let ok = false;
    try {
      const { supabaseAdmin } = require('./config/supabase');
      const query = supabaseAdmin.from('pricing_settings').select('id', { head: true, count: 'exact' }).limit(1);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Database check timed out')), 3000).unref?.());
      const { error } = await Promise.race([query, timeout]);
      if (error) throw error;
      const problems = await Promise.race([require('./lib/schemaCheck').checkSchema(), timeout]);
      schemaProblems = problems;
      ok = problems.length === 0;
    } catch (error) {
      console.error('Readiness check failed:', error.message);
      captureError(error, { route: '/api/health/ready' });
    }
    readiness = { at: Date.now(), ok };
  }
  res.status(readiness.ok ? 200 : 503).json({ status: readiness.ok ? 'ready' : 'degraded', database: readiness.ok ? 'ok' : 'error', schema: schemaProblems === null ? 'not_checked' : schemaProblems.length ? 'missing_columns' : 'ok', checkedAt: new Date(readiness.at).toISOString() });
});
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use('/api', apiRouter || ((_req, res) => res.status(503).json({ message: 'Service configuration unavailable. Contact support.' })));
app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use((error, req, res, _next) => {
  if (res.headersSent) return _next(error);
  const statusCode = error.status >= 400 && error.status < 500 ? error.status : 500;
  if (statusCode === 500) {
    console.error(JSON.stringify({ level: 'error', requestId: req.id, message: error.message, stack: error.stack }));
    captureError(error, { requestId: req.id, route: req.originalUrl.split('?')[0], userId: req.user?.id });
    flushMonitoring();
  }
  const messages = { 400: 'Invalid request body', 403: 'Forbidden', 413: 'Request too large' };
  res.status(statusCode).json({ message: messages[statusCode] || 'Request failed', requestId: req.id });
});

process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection:', reason);
  captureError(reason instanceof Error ? reason : new Error(String(reason)));
});

// Vercel calls the exported Express handler; importing it must not open a port.
module.exports = app;
if (require.main === module && !process.env.VERCEL) {
  const http = require('http');
  const server = http.createServer(app);
  // This deployment uses REST polling; attach Socket.IO only on the local Node host.
  if (apiRouter) {
    const { Server } = require('socket.io');
    const jwt = require('jsonwebtoken');
    const { fetchUserById } = require('./lib/repository');
    const { isApprovedDriver } = require('./lib/security');
    const io = new Server(server, { cors: { origin: allowedOrigins, credentials: true } });
    app.set('io', io);
    io.use(async (socket, next) => {
      try {
        const decoded = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
        const user = await fetchUserById(decoded.id);
        if (!user || (Number(decoded.tv) || 0) !== user.tokenVersion) throw new Error('Unknown account');
        socket.data.user = user;
        next();
      } catch { next(new Error('Not authorized')); }
    });
    io.on('connection', socket => {
      const user = socket.data.user;
      socket.join(user.id);
      if (isApprovedDriver(user)) socket.join('drivers');
    });
  }
  server.listen(process.env.PORT || 5000, () => console.log('KidRide server listening'));
}
