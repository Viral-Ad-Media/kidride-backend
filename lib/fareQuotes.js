const jwt = require('jsonwebtoken');
const { SERVICE_TYPES, computeFare } = require('./pricing');
const { tripMetrics } = require('./routeMetrics');

// A quote is signed and handed to the parent; booking must present it for the
// same trip, so the fare shown is the fare charged unless the trip changes.
const QUOTE_TTL = '20m';
const AUDIENCE = 'kidride-fare-quote';

// Without picked places (e.g. Google Places unavailable) the typed addresses identify the trip.
const place = (coords, address) => (coords ? [coords.lat, coords.lng] : [String(address || '').trim().toLowerCase()]);
const tripKey = ({ serviceType, pickupCoords, dropoffCoords, pickupAddress, dropoffAddress, scheduledAt, stayMinutes }) => JSON.stringify([
  serviceType, ...place(pickupCoords, pickupAddress), ...place(dropoffCoords, dropoffAddress),
  scheduledAt || null, serviceType === 'stay_with_child_and_dropoff' ? stayMinutes || 0 : 0
]);

const signQuote = (parentId, trip, fare) => jwt.sign({ sub: parentId, trip: tripKey(trip), fare }, process.env.JWT_SECRET, { audience: AUDIENCE, expiresIn: QUOTE_TTL });

/** The fare signed for this parent and trip, or null when missing, expired or for a different trip. */
const verifyQuote = (token, parentId, trip) => {
  if (typeof token !== 'string') return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { audience: AUDIENCE });
    return payload.sub === parentId && payload.trip === tripKey(trip) ? payload.fare : null;
  } catch { return null; }
};

/** Fares for every service type over one route, each with its own signed quote token. */
const quoteAllServices = async (settings, parentId, { pickupCoords, dropoffCoords, pickupAddress, dropoffAddress, scheduledAt, stayMinutes }) => {
  // No coordinates: the distance is unknown, so the minimum fare applies.
  const metrics = pickupCoords && dropoffCoords ? await tripMetrics(pickupCoords, dropoffCoords) : { miles: 0, minutes: 0, source: 'none' };
  const pickupTime = scheduledAt ? new Date(scheduledAt) : new Date();
  const quotes = {};
  for (const serviceType of SERVICE_TYPES) {
    const fare = computeFare(settings, { serviceType, miles: metrics.miles, minutes: metrics.minutes, stayMinutes, pickupTime, distanceSource: metrics.source });
    const trip = { serviceType, pickupCoords, dropoffCoords, pickupAddress, dropoffAddress, scheduledAt, stayMinutes: fare.stayMinutes };
    quotes[serviceType] = { ...fare, quoteToken: signQuote(parentId, trip, fare) };
  }
  return { currency: settings.currency, distanceSource: metrics.source, quotes };
};

module.exports = { quoteAllServices, verifyQuote, tripKey };
