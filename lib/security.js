const crypto = require('node:crypto');
const isApprovedDriver = (user) => user.role === 'driver' && user.isVerifiedDriver === true && user.driverApplicationStatus === 'approved';
const ACTIVE_STATUSES = ['driver_assigned', 'driver_arrived_at_pickup', 'child_picked_up'];
const quoteFare = (serviceType) => {
  let prices;
  try { prices = JSON.parse(process.env.SERVICE_PRICES_JSON || '{}'); } catch { prices = {}; }
  const price = prices[serviceType];
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 99999999 || Math.round(price * 100) / 100 !== price) {
    const error = new Error('Pricing is temporarily unavailable for this service.');
    error.status = 503;
    throw error;
  }
  return price;
};
// An offer shows how many children (seats) the ride needs, not who they are.
const redactOffer = (ride) => { const { tripCode, safeWord, child, childIds, children, parent, ...offer } = ride; return { ...offer, childCount: (childIds || []).length || 1 }; };
const generateTripCode = () => String(crypto.randomInt(1000, 10000));
const generateSafeWord = () => { const words = ['Maple', 'Comet', 'Falcon', 'River', 'Atlas', 'Meadow', 'Cedar', 'Echo', 'Sunrise', 'Willow', 'Harbor', 'Orchid']; return `${words[crypto.randomInt(words.length)]}-${words[crypto.randomInt(words.length)]}-${crypto.randomInt(100, 1000)}`; };
const optionalNumber = (value, min, max) => value == null || (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max);
// heading: degrees clockwise from north (0-360); speed: metres per second.
const validateCoordinates = ({ latitude, longitude, accuracy, heading, speed }) => typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 && optionalNumber(accuracy, 0, Infinity) && optionalNumber(heading, 0, 360) && optionalNumber(speed, 0, 150);
// A place picked from address suggestions: { lat, lng }. Anything else is ignored.
const parsePlaceCoords = (value) => {
  if (!value || typeof value !== 'object') return null;
  const { lat, lng } = value;
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 && typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180 ? { lat, lng } : null;
};
// Pickup and drop-off are the same place: the same address text (ignoring case,
// spaces and punctuation) or picked points less than 150 m apart.
const SAME_PLACE_METERS = 150;
const SAME_PLACE_MESSAGE = 'Pickup and drop-off are the same place. Choose a different drop-off.';
const isSamePlace = (pickupAddress, dropoffAddress, pickupCoords, dropoffCoords) => {
  const norm = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm(pickupAddress) && norm(pickupAddress) === norm(dropoffAddress)) return true;
  if (!pickupCoords || !dropoffCoords) return false;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(dropoffCoords.lat - pickupCoords.lat);
  const dLng = toRad(dropoffCoords.lng - pickupCoords.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(pickupCoords.lat)) * Math.cos(toRad(dropoffCoords.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h)) < SAME_PLACE_METERS;
};
module.exports = { isSamePlace, SAME_PLACE_MESSAGE, isApprovedDriver, ACTIVE_STATUSES, quoteFare, redactOffer, generateTripCode, generateSafeWord, validateCoordinates, parsePlaceCoords };
