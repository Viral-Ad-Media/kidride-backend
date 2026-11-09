// Error monitoring. Sentry loads only when SENTRY_DSN is set; otherwise every
// function here is a no-op, so local runs and tests never send anything.
let sentry = null;

const initMonitoring = () => {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn || sentry) return Boolean(sentry);
  try {
    sentry = require('@sentry/node');
    sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
      tracesSampleRate: 0,
      // Children's data: never attach request bodies, cookies, headers or IPs.
      sendDefaultPii: false,
      beforeSend(event) {
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          delete event.request.headers;
          delete event.request.query_string;
        }
        if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
        return event;
      }
    });
  } catch (error) {
    sentry = null;
    console.error('Error monitoring failed to start:', error.message);
  }
  return Boolean(sentry);
};

const captureError = (error, context = {}) => {
  if (!sentry) return;
  try {
    sentry.withScope(scope => {
      if (context.requestId) scope.setTag('request_id', context.requestId);
      if (context.route) scope.setTag('route', context.route);
      if (context.userId) scope.setUser({ id: context.userId });
      sentry.captureException(error);
    });
  } catch { /* monitoring must never break a request */ }
};

// Serverless functions can freeze right after responding; flush briefly.
const flushMonitoring = (timeoutMs = 1500) => (sentry ? sentry.flush(timeoutMs).catch(() => false) : Promise.resolve(true));

module.exports = { initMonitoring, captureError, flushMonitoring, isMonitoringEnabled: () => Boolean(sentry) };
