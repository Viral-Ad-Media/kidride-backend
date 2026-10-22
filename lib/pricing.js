// Fare engine. Pure functions only: settings come from lib/pricingSettings.js
// (the admin-edited pricing_settings row) and trip metrics from lib/routeMetrics.js.
//
// fare = max(minimum, base + perMile x miles + perMinute x minutes) x service multiplier
//        + stay time + extra children + school-run peak + booking fee
// The driver gets driverShare of everything except the booking fee, plus all of the peak fee.

const SERVICE_TYPES = ['pickup_only', 'dropoff_only', 'pickup_and_dropoff', 'stay_with_child_and_dropoff'];
const STAY_SERVICE = 'stay_with_child_and_dropoff';

const DEFAULT_PRICING = Object.freeze({
  currency: 'USD',
  timezone: 'America/New_York',
  baseFare: 5,
  perMile: 1.5,
  perMinute: 0.35,
  minimumFare: 15,
  bookingFee: 2.5,
  peakSurcharge: 3,
  peakWindows: ['07:00-09:00', '14:30-16:30'],
  extraChildFee: 5,
  // Pickup and drop-off is two legs priced together with 10% off (2 x 0.9).
  serviceMultipliers: { pickup_only: 1, dropoff_only: 1, pickup_and_dropoff: 1.8, stay_with_child_and_dropoff: 1 },
  stayPerMinute: 0.4,
  stayMinimumMinutes: 15,
  driverShare: 0.8,
  cancellation: { freeMinutesAfterBooking: 2, freeHoursBeforeScheduled: 8, driverAssignedFee: 5, lateWindowMinutes: 60, latePercent: 50, noShowWaitMinutes: 10, noShowFee: 10 }
});

const MAX_STAY_MINUTES = 8 * 60;
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

const money = (value, name, max = 10000) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw invalid(`${name} must be a number from 0 to ${max}`);
  return round2(value);
};
const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Merges stored values over the defaults and rejects anything malformed. */
const normalizeSettings = (input = {}) => {
  const raw = { ...DEFAULT_PRICING, ...input };
  if (typeof raw.currency !== 'string' || !/^[A-Z]{3}$/.test(raw.currency)) throw invalid('Currency must be a 3-letter code such as USD');
  try { new Intl.DateTimeFormat('en-US', { timeZone: raw.timezone }); } catch { throw invalid('Time zone is not recognised'); }
  if (!Array.isArray(raw.peakWindows) || raw.peakWindows.length > 6 || raw.peakWindows.some((w) => typeof w !== 'string' || !WINDOW.test(w) || toMinutes(w.slice(0, 5)) >= toMinutes(w.slice(6)))) {
    throw invalid('Peak windows must look like 07:00-09:00, with the start before the end');
  }
  const multipliers = { ...DEFAULT_PRICING.serviceMultipliers, ...(raw.serviceMultipliers || {}) };
  for (const type of SERVICE_TYPES) {
    const m = multipliers[type];
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0 || m > 10) throw invalid('Service multipliers must be between 0 and 10');
  }
  const cancel = { ...DEFAULT_PRICING.cancellation, ...(raw.cancellation || {}) };
  if (typeof raw.driverShare !== 'number' || !(raw.driverShare >= 0 && raw.driverShare <= 1)) throw invalid('Driver share must be between 0 and 1');
  if (typeof cancel.latePercent !== 'number' || !(cancel.latePercent >= 0 && cancel.latePercent <= 100)) throw invalid('Late cancellation percent must be between 0 and 100');
  if (!Number.isInteger(raw.stayMinimumMinutes) || raw.stayMinimumMinutes < 0 || raw.stayMinimumMinutes > MAX_STAY_MINUTES) throw invalid('Stay minimum must be whole minutes');
  return {
    currency: raw.currency,
    timezone: raw.timezone,
    baseFare: money(raw.baseFare, 'Base fare'),
    perMile: money(raw.perMile, 'Per mile'),
    perMinute: money(raw.perMinute, 'Per minute'),
    minimumFare: money(raw.minimumFare, 'Minimum fare'),
    bookingFee: money(raw.bookingFee, 'Booking fee'),
    peakSurcharge: money(raw.peakSurcharge, 'Peak surcharge'),
    peakWindows: [...raw.peakWindows],
    extraChildFee: money(raw.extraChildFee, 'Extra child fee'),
    serviceMultipliers: Object.fromEntries(SERVICE_TYPES.map((type) => [type, multipliers[type]])),
    stayPerMinute: money(raw.stayPerMinute, 'Stay per minute'),
    stayMinimumMinutes: raw.stayMinimumMinutes,
    driverShare: raw.driverShare,
    cancellation: {
      freeMinutesAfterBooking: money(cancel.freeMinutesAfterBooking, 'Free cancellation minutes', 1440),
      freeHoursBeforeScheduled: money(cancel.freeHoursBeforeScheduled, 'Free cancellation hours', 720),
      driverAssignedFee: money(cancel.driverAssignedFee, 'Cancellation fee'),
      lateWindowMinutes: money(cancel.lateWindowMinutes, 'Late cancellation window', 1440),
      latePercent: cancel.latePercent,
      // The driver may record a no-show this long after arriving; the parent then pays noShowFee.
      noShowWaitMinutes: money(cancel.noShowWaitMinutes, 'No-show wait', 120),
      noShowFee: money(cancel.noShowFee, 'No-show fee')
    }
  };
};

/** Minutes since local midnight of `date` in `timezone`. */
const localMinutes = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return get('hour') * 60 + get('minute');
};
// `at` is minutes since local midnight, or a Date read in the pricing time zone.
const isPeak = (settings, at) => {
  if (at instanceof Date) at = localMinutes(at, settings.timezone);
  return settings.peakWindows.some((w) => at >= toMinutes(w.slice(0, 5)) && at < toMinutes(w.slice(6)));
};

/**
 * trip: { serviceType, miles, minutes, pickupTime (Date) or localMinutes, extraChildren?, stayMinutes?, distanceSource? }
 * Returns { total, currency, driverEarnings, miles, minutes, stayMinutes, distanceSource, lines: [{ key, label, amount }] }.
 */
const computeFare = (settings, trip) => {
  if (!SERVICE_TYPES.includes(trip.serviceType)) throw invalid('Invalid service type');
  const miles = round2(Math.max(0, Number(trip.miles) || 0));
  const minutes = Math.max(0, Math.round(Number(trip.minutes) || 0));
  const extraChildren = Math.max(0, Math.floor(Number(trip.extraChildren) || 0));
  const isStay = trip.serviceType === STAY_SERVICE;
  const stayMinutes = isStay ? Math.max(settings.stayMinimumMinutes, Math.round(Number(trip.stayMinutes) || 0)) : 0;
  if (stayMinutes > MAX_STAY_MINUTES) throw invalid(`Stay time can be up to ${MAX_STAY_MINUTES / 60} hours`);

  const distanceFare = settings.baseFare + settings.perMile * miles + settings.perMinute * minutes;
  const minimumApplied = distanceFare < settings.minimumFare;
  const multiplier = settings.serviceMultipliers[trip.serviceType];
  const lines = [{
    key: 'trip',
    label: `${minimumApplied ? 'Minimum fare' : 'Trip'} (${trip.distanceSource === 'none' ? 'distance unknown' : `${miles.toFixed(1)} mi, ${minutes} min`})${multiplier !== 1 ? ` x${multiplier}` : ''}`,
    amount: round2(Math.max(settings.minimumFare, distanceFare) * multiplier)
  }];
  if (isStay) lines.push({ key: 'stay', label: `Stay with child (${stayMinutes} min)`, amount: round2(settings.stayPerMinute * stayMinutes) });
  if (extraChildren) lines.push({ key: 'extra_children', label: `Extra child${extraChildren > 1 ? ` x${extraChildren}` : ''}`, amount: round2(settings.extraChildFee * extraChildren) });
  if (settings.peakSurcharge > 0 && isPeak(settings, Number.isInteger(trip.localMinutes) ? trip.localMinutes : trip.pickupTime || new Date())) lines.push({ key: 'peak', label: 'School-run peak', amount: settings.peakSurcharge });
  if (settings.bookingFee > 0) lines.push({ key: 'booking_fee', label: 'Booking fee', amount: settings.bookingFee });

  const amountOf = (key) => lines.find((line) => line.key === key)?.amount || 0;
  const shared = lines.filter((line) => !['peak', 'booking_fee'].includes(line.key)).reduce((sum, line) => sum + line.amount, 0);
  return {
    total: round2(lines.reduce((sum, line) => sum + line.amount, 0)),
    currency: settings.currency,
    driverEarnings: round2(shared * settings.driverShare + amountOf('peak')),
    miles,
    minutes,
    stayMinutes,
    distanceSource: trip.distanceSource || 'routes',
    lines
  };
};

/**
 * What a parent owes for cancelling. Driver and admin cancellations are free.
 * ride: { status, total, createdAt, pickupTime, isScheduled, driverAssigned }
 */
const cancellationFee = (settings, ride, { now = new Date(), byParent = true } = {}) => {
  if (!byParent) return 0;
  const rules = settings.cancellation;
  if (now - new Date(ride.createdAt) < rules.freeMinutesAfterBooking * 60000) return 0;
  const untilPickup = new Date(ride.pickupTime) - now;
  if (ride.isScheduled) {
    if (untilPickup >= rules.freeHoursBeforeScheduled * 3600000) return 0;
    if (untilPickup <= rules.lateWindowMinutes * 60000) return round2(ride.total * rules.latePercent / 100);
  }
  return ride.driverAssigned ? Math.min(rules.driverAssignedFee, ride.total) : 0;
};

module.exports = { SERVICE_TYPES, DEFAULT_PRICING, normalizeSettings, computeFare, cancellationFee, isPeak, round2 };
