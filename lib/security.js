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
const redactOffer = (ride) => { const { tripCode, safeWord, child, parent, ...offer } = ride; return offer; };
const generateTripCode = () => String(crypto.randomInt(1000, 10000));
const generateSafeWord = () => { const words = ['Maple', 'Comet', 'Falcon', 'River', 'Atlas', 'Meadow', 'Cedar', 'Echo', 'Sunrise', 'Willow', 'Harbor', 'Orchid']; return `${words[crypto.randomInt(words.length)]}-${words[crypto.randomInt(words.length)]}-${crypto.randomInt(100, 1000)}`; };
const validateCoordinates = ({ latitude, longitude, accuracy }) => typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 && (accuracy == null || (typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0));
module.exports = { isApprovedDriver, ACTIVE_STATUSES, quoteFare, redactOffer, generateTripCode, generateSafeWord, validateCoordinates };
