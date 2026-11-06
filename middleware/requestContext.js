const { randomUUID } = require('node:crypto');

// Request id, baseline security headers and one structured log line for
// failed or slow API calls. Paths are logged without query strings.
const SLOW_MS = 2000;
const QUIET_PATHS = new Set(['/', '/health', '/api/health', '/api/health/ready', '/favicon.ico']);

const requestContext = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[A-Za-z0-9._-]{8,80}$/.test(incoming) ? incoming : randomUUID();
  res.set('X-Request-Id', req.id);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Resource-Policy', 'same-site');
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');

  const started = process.hrtime.bigint();
  const path = req.originalUrl.split('?')[0];
  res.on('finish', () => {
    if (QUIET_PATHS.has(path)) return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (res.statusCode < 400 && ms < SLOW_MS) return;
    const line = JSON.stringify({
      level: res.statusCode >= 500 ? 'error' : 'warn',
      requestId: req.id, method: req.method, path,
      status: res.statusCode, ms: Math.round(ms), user: req.user?.id
    });
    (res.statusCode >= 500 ? console.error : console.warn)(line);
  });
  next();
};

module.exports = { requestContext };
