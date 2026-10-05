const parsePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
};

const getClientIdentifier = (req) => {
  if (req.ip) {
    return req.ip;
  }

  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }

  return 'unknown-client';
};

const createRateLimiter = ({
  windowMs = 15 * 60 * 1000,
  max = 100,
  message = 'Too many requests. Please try again later.',
  keyPrefix = 'global',
  keyGenerator,
  consume
} = {}) => {
  const store = new Map();
  const cleanupIntervalMs = Math.min(windowMs, 60 * 1000);

  const cleanupExpiredEntries = () => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.resetTime <= now) {
        store.delete(key);
      }
    }
  };

  const interval = setInterval(cleanupExpiredEntries, cleanupIntervalMs);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  return async (req, res, next) => {
    const now = Date.now();
    let clientKey;

    if (typeof keyGenerator === 'function') {
      try {
        clientKey = keyGenerator(req);
      } catch (error) {
        clientKey = null;
      }
    }

    const keySource = clientKey || getClientIdentifier(req);
    const key = `${keyPrefix}:${String(keySource)}`;
    let entry = store.get(key);

    if (!entry || entry.resetTime <= now) {
      entry = {
        count: 0,
        resetTime: now + windowMs
      };
    }

    entry.count += 1;
    store.set(key, entry);

    if (consume || process.env.NODE_ENV === 'production') {
      try {
        const persistentCount = consume ? await consume(key, windowMs) : await require('../lib/rateLimitStore').consume(key, windowMs);
        entry.count = persistentCount;
      } catch { return res.status(503).json({ message: 'Request protection unavailable. Please try again shortly.' }); }
    }
    const remaining = Math.max(0, max - entry.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetTime - now) / 1000));

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(retryAfterSeconds));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        message,
        retryAfterSeconds
      });
    }

    return next();
  };
};

module.exports = {
  createRateLimiter,
  parsePositiveInt,
  getClientIdentifier
};
