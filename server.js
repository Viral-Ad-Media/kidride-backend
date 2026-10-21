const dotenv = require('dotenv');
dotenv.config({ quiet: true });
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const { createRateLimiter, parsePositiveInt } = require('./middleware/rateLimitMiddleware');

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || (process.env.VERCEL ? 1 : 0)));
const allowedOrigins = (process.env.FRONTEND_URLS || 'http://localhost:3000,http://localhost:5173')
  .split(',').map(origin => origin.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => !origin || allowedOrigins.includes(origin)
    ? callback(null, true) : callback(new Error('Not allowed by CORS')),
  credentials: true
}));
app.use(express.json());
// Express 5 leaves req.body undefined when no JSON body was parsed.
app.use((req, _res, next) => { if (req.body === undefined) req.body = {}; next(); });

// Load all API dependencies atomically. Missing config must not kill the function.
let apiRouter;
try {
  connectDB();
  const router = express.Router();
  router.use(createRateLimiter({
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: parsePositiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 1000),
    message: 'Too many requests. Please try again later.', keyPrefix: 'global'
  }));
  router.use('/auth', require('./routes/authRoutes'));
  router.use('/users/me/trusted-contacts', require('./routes/trustedContactRoutes'));
  router.use('/users', require('./routes/adminUserRoutes'));
  router.use('/users', require('./routes/userRoutes'));
  router.use('/drivers', require('./routes/driverRoutes'));
  router.use('/admin/live-map', require('./routes/adminLiveRoutes'));
  router.use('/rides', require('./routes/rideRoutes'));
  router.use('/safety-chat', require('./routes/safetyRoutes'));
  router.use('/notification-receipts', require('./routes/receiptRoutes'));
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
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use('/api', apiRouter || ((_req, res) => res.status(503).json({ message: 'Service configuration unavailable. Contact support.' })));
app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
app.use((error, _req, res, _next) => {
  if (res.headersSent) return _next(error);
  const statusCode = error.status >= 400 && error.status < 500 ? error.status : 500;
  res.status(statusCode).json({ message: statusCode === 400 ? 'Invalid request body' : 'Request failed' });
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
