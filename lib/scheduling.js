// Rides booked for later. A scheduled ride is held back from drivers until
// DISPATCH_LEAD_MS before pickup, then released into the normal nearest-driver
// dispatch. Until CURRENT_LEAD_MS before pickup it lives in the "Upcoming"
// lists rather than as the parent's or driver's current trip.

const MINUTE = 60 * 1000;
const MIN_LEAD_MS = 30 * MINUTE;
const MAX_AHEAD_MS = 30 * 24 * 60 * MINUTE;
const STEP_MINUTES = 5;
const DISPATCH_LEAD_MS = 30 * MINUTE;
const CURRENT_LEAD_MS = 15 * MINUTE;
const ATTENTION_LEAD_MS = 5 * MINUTE;
const MAX_SCHEDULED_PER_PARENT = 10;
// Clock skew allowance for the 30-minute minimum when booking.
const BOOKING_GRACE_MS = 2 * MINUTE;
const NOT_STARTED_STATUSES = ['requested', 'searching_driver', 'driver_assigned'];
const SEARCHING_STATUSES = ['requested', 'searching_driver'];

const pickupMs = (ride) => Date.parse(ride.pickup_time);

/** Returns an error message, or null when the time can be booked. */
const validateScheduledTime = (date, now = Date.now()) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'Choose a valid pickup date and time';
  if (date.getTime() < now + MIN_LEAD_MS - BOOKING_GRACE_MS) return 'Scheduled rides must be at least 30 minutes from now';
  if (date.getTime() > now + MAX_AHEAD_MS) return 'Scheduled rides can be booked up to 30 days ahead';
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0 || date.getUTCMinutes() % STEP_MINUTES !== 0) return 'Choose a pickup time in 5-minute steps';
  return null;
};

/** Still waiting for its dispatch window: drivers cannot see or accept it. */
const isHeld = (ride) => !!ride.is_scheduled && !ride.dispatch_released_at && SEARCHING_STATUSES.includes(ride.status);

/** No driver yet and pickup is 5 minutes away (or overdue). */
const needsAttention = (ride, now = Date.now()) => !!ride.is_scheduled && !ride.driver_id
  && SEARCHING_STATUSES.includes(ride.status) && pickupMs(ride) - now <= ATTENTION_LEAD_MS;

/** The ride is the user's current trip rather than an upcoming one. */
const isCurrent = (ride, now = Date.now()) => !ride.is_scheduled
  || !NOT_STARTED_STATUSES.includes(ride.status)
  || pickupMs(ride) - now <= CURRENT_LEAD_MS;

/** An accepted ride for later does not keep its driver from other trips until it is near. */
const keepsDriverBusy = (ride, now = Date.now()) => !(ride.is_scheduled && ride.status === 'driver_assigned' && pickupMs(ride) - now > CURRENT_LEAD_MS);

const scheduleState = (ride, now = Date.now()) => {
  if (!ride.is_scheduled) return null;
  if (isHeld(ride)) return 'scheduled';
  if (needsAttention(ride, now)) return 'needs_attention';
  return SEARCHING_STATUSES.includes(ride.status) ? 'dispatching' : 'assigned';
};

module.exports = {
  MIN_LEAD_MS,
  MAX_AHEAD_MS,
  DISPATCH_LEAD_MS,
  CURRENT_LEAD_MS,
  ATTENTION_LEAD_MS,
  MAX_SCHEDULED_PER_PARENT,
  NOT_STARTED_STATUSES,
  validateScheduledTime,
  isHeld,
  needsAttention,
  isCurrent,
  keepsDriverBusy,
  scheduleState
};
