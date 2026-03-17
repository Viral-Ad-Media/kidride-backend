const { supabaseAdmin } = require('../config/supabase');

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
  trip_code,
  safe_word,
  service_type,
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
  vehicle: (profile.vehicle && typeof profile.vehicle === 'object') ? profile.vehicle : {}
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
  pickupTime: ride.pickup_time,
  status: ride.status,
  price: Number(ride.price),
  tripCode: ride.trip_code || '',
  safeWord: ride.safe_word || '',
  serviceType: ride.service_type
});

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
    .order('created_at', { ascending: true });

  return ensureData(data || [], error, 'Unable to load children');
};

const fetchUserById = async (id) => {
  const profile = await fetchProfileRowById(id);
  if (!profile) {
    return null;
  }

  const children = await fetchChildrenRowsByParentId(id);
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

const updateRideRow = async (id, updates) => {
  const { data, error } = await supabaseAdmin
    .from('rides')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select(RIDE_SELECT)
    .single();

  return ensureData(data, error, 'Unable to update ride');
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
  formatRide
};
