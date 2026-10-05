const express = require('express');
const http = require('http');
const dotenv = require('dotenv');
const cors = require('cors');
const { Server } = require('socket.io');
const connectDB = require('./config/db');
const { createRateLimiter, parsePositiveInt } = require('./middleware/rateLimitMiddleware');

// Load config
dotenv.config();
connectDB();

const app = express();
const server = http.createServer(app);
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || (process.env.VERCEL ? 1 : 0)));
const allowedOrigins = (process.env.FRONTEND_URLS || 'http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const globalRateLimitWindowMs = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const globalRateLimitMaxRequests = parsePositiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 1000);
const globalRateLimiter = createRateLimiter({
  windowMs: globalRateLimitWindowMs,
  max: globalRateLimitMaxRequests,
  message: 'Too many requests. Please try again later.',
  keyPrefix: 'global'
});

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(globalRateLimiter);

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/rides', require('./routes/rideRoutes'));
app.use('/api/safety-chat', require('./routes/safetyRoutes'));
app.use('/api/notification-receipts', require('./routes/receiptRoutes'));

// Socket.io Setup
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true
  }
});

// Pass io to routes via request object if needed, or handle here
app.set('io', io);

const jwt = require('jsonwebtoken');
const { fetchUserById } = require('./lib/repository');
const { isApprovedDriver } = require('./lib/security');
io.use(async (socket, next) => {
  try {
    const decoded = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
    const user = await fetchUserById(decoded.id);
    if (!user) throw new Error('Unknown account');
    socket.data.user = user;
    next();
  } catch { next(new Error('Not authorized')); }
});
io.on('connection', socket => {
  const user = socket.data.user;
  socket.join(user.id);
  if (isApprovedDriver(user)) socket.join('drivers');
  // Ride writes and coordinates use authenticated REST routes only.
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
