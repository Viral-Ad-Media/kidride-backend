const parsePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const getClientIdentifier = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

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
  keyGenerator
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

  return (req, res, next) => {
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
