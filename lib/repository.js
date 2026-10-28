const { supabaseAdmin } = require('../config/supabase');
const { scheduleState } = require('../lib/scheduling');

const PROFILE_SELECT = `
  id,
  name,
  email,
  role,
  phone,
  photo_url,
  is_verified_driver,
  driver_application_status,
  vehicle,
  notify_email,
  token_version,
  is_blocked,
  blocked_reason,
  created_at,
  updated_at
`;

const CHILD_SELECT = `
  id,
  parent_id,
  name,
  age,
  notes,
  photo_url,
  created_at,
  updated_at
`;

const RIDE_SELECT = `
  id,
  parent_id,
  child_id,
  driver_id,
  pickup_location,
  dropoff_location,
  pickup_time,
  status,
  price,
  currency,
  driver_earnings,
  fare_breakdown,
  cancellation_fee,
  trip_code,
  safe_word,
  service_type,
  driver_location,
  pickup_coords,
  dropoff_coords,
  dispatch_state,
  is_scheduled,
  dispatch_released_at,
  arrived_at,
  trip_code_attempts,
  trip_code_verified_at,
  safety_alert,
  safety_alert_at,
  monitor,
  cancel_reason,
  created_at,
  updated_at,
  parent:profiles!rides_parent_id_fkey (
    id,
    name,
    photo_url
  ),
  driver:profiles!rides_driver_id_fkey (
    id,
    name,
    photo_url,
    phone,
    is_verified_driver,
    vehicle
  )
`;

const ensureData = (data, error, fallbackMessage) => {
  if (error) {
    const message = error.message || fallbackMessage;
    const wrappedError = new Error(message);
    wrappedError.code = error.code;
    throw wrappedError;
  }

  return data;
};

const formatChild = (child) => ({
  id: child.id,
  _id: child.id,
  name: child.name,
  age: Number(child.age),
  notes: child.notes || undefined,
  photoUrl: child.photo_url || undefined
});

const formatProfile = (profile, children = []) => ({
  id: profile.id,
  _id: profile.id,
  name: profile.name,
  email: profile.email,
  role: profile.role,
  phone: profile.phone || null,
  photoUrl: profile.photo_url || null,
  children: children.map(formatChild),
  isVerifiedDriver: !!profile.is_verified_driver,
  driverApplicationStatus: profile.driver_application_status || 'none',
  vehicle: (profile.vehicle && typeof profile.vehicle === 'object') ? profile.vehicle : {},
  notifyEmail: profile.notify_email !== false,
  tokenVersion: Number(profile.token_version) || 0,
  isBlocked: !!profile.is_blocked,
  blockedReason: profile.blocked_reason || null
});

const formatRelatedUser = (user, includeDriverFields = false) => {
  if (!user) {
    return null;
  }

  const payload = {
    id: user.id,
    _id: user.id,
    name: user.name,
    photoUrl: user.photo_url || null
  };

  if (includeDriverFields) {
    payload.isVerifiedDriver = !!user.is_verified_driver;
    payload.vehicle = (user.vehicle && typeof user.vehicle === 'object') ? user.vehicle : {};
    // So the parent can call or text the driver of their ride.
    payload.phone = user.phone || null;
  }

  return payload;
};

const formatRide = (ride) => ({
  id: ride.id,
  _id: ride.id,
  parent: formatRelatedUser(ride.parent) || ride.parent_id,
  child: ride.child_id,
  driver: formatRelatedUser(ride.driver, true) || ride.driver_id || null,
  pickupLocation: ride.pickup_location,
  dropoffLocation: ride.dropoff_location,
  pickupCoords: ride.pickup_coords || null,
  dropoffCoords: ride.dropoff_coords || null,
  dispatchState: ride.dispatch_state || 'open',
  pickupTime: ride.pickup_time,
  isScheduled: !!ride.is_scheduled,
  // scheduled (not yet offered) | dispatching | assigned | needs_attention; null for rides booked for now.
  scheduleState: scheduleState(ride),
  status: ride.status,
  price: Number(ride.price),
  currency: ride.currency || 'USD',
  // Older rides (flat prices) have no breakdown; the driver then earned the whole price.
  fare: ride.fare_breakdown ? { ...ride.fare_breakdown, total: Number(ride.price) } : null,
  driverEarnings: ride.driver_earnings == null ? Number(ride.price) : Number(ride.driver_earnings),
  cancellationFee: Number(ride.cancellation_fee) || 0,
  tripCode: ride.trip_code || '',
  safeWord: ride.safe_word || '',
  serviceType: ride.service_type,
  arrivedAt: ride.arrived_at || null,
  tripCodeVerified: !!ride.trip_code_verified_at,
  tripCodeAttempts: Number(ride.trip_code_attempts) || 0,
  // The most serious open safety incident: sos | trip_code | off_route | stalled.
  safetyAlert: ride.safety_alert || null,
  safetyAlertAt: ride.safety_alert_at || null,
  cancelReason: ride.cancel_reason || null,
  // A finished trip's last GPS fix is not shown to anyone.
  driverLocation: ['completed', 'cancelled'].includes(ride.status) ? null : (ride.driver_location || null)
});

// The assigned driver never sees the trip code: the parent (or child) tells it
// to them at the pickup and they enter it to start the trip.
const formatRideFor = (user, ride) => {
  const payload = formatRide(ride);
  if (user && user.role !== 'admin' && ride.driver_id === user.id && ride.parent_id !== user.id) payload.tripCode = '';
  return payload;
};

const fetchProfileRowById = async (id) => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('id', id)
    .maybeSingle();

  return ensureData(data, error, 'Unable to load profile');
};

const fetchChildrenRowsByParentId = async (parentId) => {
  const { data, error } = await supabaseAdmin
    .from('children')
    .select(CHILD_SELECT)
    .eq('parent_id', parentId)
    .is('archived_at', null)
    .order('created_at', { ascending: true });

  return ensureData(data || [], error, 'Unable to load children');
};

// Every authenticated request loads the user, so fetch both in one round trip.
const fetchUserById = async (id) => {
  const [profile, children] = await Promise.all([fetchProfileRowById(id), fetchChildrenRowsByParentId(id)]);
  if (!profile) {
    return null;
  }

  return formatProfile(profile, children);
};

const upsertProfileRow = async (profile) => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .upsert(profile, { onConflict: 'id' })
    .select(PROFILE_SELECT)
    .single();

  return ensureData(data, error, 'Unable to save profile');
};

const updateProfileRowById = async (id, updates) => {
  const payload = {
    ...updates,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update(payload)
    .eq('id', id)
    .select(PROFILE_SELECT)
    .single();

  return ensureData(data, error, 'Unable to update profile');
};

const insertChildRow = async (payload) => {
  const { data, error } = await supabaseAdmin
    .from('children')
    .insert(payload)
    .select(CHILD_SELECT)
    .single();

  return ensureData(data, error, 'Unable to create child');
};

const fetchRideRowById = async (id) => {
  const { data, error } = await supabaseAdmin
    .from('rides')
    .select(RIDE_SELECT)
    .eq('id', id)
    .maybeSingle();

  return ensureData(data, error, 'Unable to load ride');
};

const fetchRideById = async (id) => {
  const ride = await fetchRideRowById(id);
  return ride ? formatRide(ride) : null;
};

const fetchRideRows = async (queryBuilder) => {
  const { data, error } = await queryBuilder;
  return ensureData(data || [], error, 'Unable to load rides');
};

const updateRideRow = async (id, updates, expectedStatus, driverId) => {
  let query = supabaseAdmin
    .from('rides')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', id);
  if (expectedStatus) query = query.eq('status', expectedStatus);
  if (driverId) query = query.eq('driver_id', driverId);
  const { data, error } = await query.select(RIDE_SELECT).maybeSingle();
  const result = ensureData(data, error, 'Unable to update ride');
  if (!result) { const conflict = new Error('Ride changed. Refresh and try again.'); conflict.status = 409; throw conflict; }
  return result;
};

module.exports = {
  PROFILE_SELECT,
  CHILD_SELECT,
  RIDE_SELECT,
  fetchProfileRowById,
  fetchChildrenRowsByParentId,
  fetchUserById,
  upsertProfileRow,
  updateProfileRowById,
  insertChildRow,
  fetchRideRowById,
  fetchRideById,
  fetchRideRows,
  updateRideRow,
  formatChild,
  formatProfile,
  formatRide,
  formatRideFor
};
