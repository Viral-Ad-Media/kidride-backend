// Account deletion and data export.
//
// Rides, ratings and safety incidents reference the profile, and other people
// (the driver, the parent, the operator) have a legitimate need for that
// history, so a deleted account is anonymised rather than removed: personal
// details are wiped, the login is closed and the email address is freed.
const TERMS_VERSION = '2026-11-06-draft';
const OPEN_RIDE_STATUSES = ['requested', 'searching_driver', 'driver_assigned', 'driver_arrived_at_pickup', 'child_picked_up'];

const deletedEmail = (userId) => `deleted+${userId}@deleted.kidride.invalid`;

const anonymisedProfile = (userId, now = new Date()) => ({
  name: 'Deleted user',
  email: deletedEmail(userId),
  phone: null,
  photo_url: null,
  vehicle: {},
  is_verified_driver: false,
  notify_email: false,
  is_blocked: true,
  blocked_reason: 'account_deleted',
  blocked_at: now.toISOString(),
  deleted_at: now.toISOString(),
  updated_at: now.toISOString()
});

const anonymisedChild = (now = new Date()) => ({
  name: 'Deleted child',
  notes: null,
  photo_url: null,
  archived_at: now.toISOString(),
  updated_at: now.toISOString()
});

// A ride blocks deletion while it is under way. Unstarted scheduled rides
// are cancelled instead, since no driver is with the child yet.
const blockingRide = (rides) => rides.find((ride) => (
  OPEN_RIDE_STATUSES.includes(ride.status) && !(ride.is_scheduled && ['requested', 'searching_driver', 'driver_assigned'].includes(ride.status))
)) || null;

const accountError = (status, message) => Object.assign(new Error(message), { status });

module.exports = { TERMS_VERSION, OPEN_RIDE_STATUSES, deletedEmail, anonymisedProfile, anonymisedChild, blockingRide, accountError };
