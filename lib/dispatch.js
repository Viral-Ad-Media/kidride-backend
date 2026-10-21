const h3 = require('h3-js');
const { supabaseAdmin } = require('../config/supabase');
const scheduling = require('../lib/scheduling');

// Nearest-driver dispatch using H3 hexagons (Uber's open-source grid).
// A ride with known pickup coordinates is offered to the nearest online driver
// for OFFER_SECONDS; when that offer expires or is declined it goes to the next
// nearest, up to MAX_TARGETED_OFFERS drivers, searching up to MAX_RING rings of
// cells around the pickup. After that (or when nobody is near) the ride opens
// to every driver, which is how all rides worked before.
//
// There are no background jobs (Vercel functions only run per request), so
// dispatch advances lazily whenever drivers or the parent poll.

const H3_RESOLUTION = 8; // cells about 460 m across
const MAX_RING = 3; // up to roughly 3 km from the pickup
const OFFER_SECONDS = 20;
const MAX_TARGETED_OFFERS = 3;
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const BUSY_STATUSES = ['driver_assigned', 'driver_arrived_at_pickup', 'child_picked_up'];
const SEARCHING_STATUSES = ['requested', 'searching_driver'];

const cellFor = (lat, lng) => h3.latLngToCell(lat, lng, H3_RESOLUTION);

const distanceMeters = (a, b) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

/** Stores a driver's current position (called by the presence heartbeat). */
const saveDriverLocation = async (driverId, { latitude, longitude, heading }) => {
  const { error } = await supabaseAdmin.from('driver_locations').upsert({
    driver_id: driverId,
    lat: latitude,
    lng: longitude,
    heading: typeof heading === 'number' ? heading : null,
    h3_index: cellFor(latitude, longitude),
    updated_at: new Date().toISOString()
  }, { onConflict: 'driver_id' });
  if (error) throw error;
};

/**
 * Online, approved, unblocked drivers who are not on a trip, nearest first.
 * Searches ring 1, then 2, then 3 around the pickup and stops at the first ring
 * with anyone in it.
 */
const findNearbyDrivers = async (coords, exclude = new Set()) => {
  const origin = cellFor(coords.lat, coords.lng);
  const since = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  for (let ring = 1; ring <= MAX_RING; ring++) {
    const { data, error } = await supabaseAdmin
      .from('driver_locations')
      .select('driver_id, lat, lng')
      .in('h3_index', h3.gridDisk(origin, ring))
      .gte('updated_at', since);
    if (error) throw error;
    const located = (data || []).filter((row) => !exclude.has(row.driver_id));
    if (!located.length) continue;
    const ids = located.map((row) => row.driver_id);
    const [profiles, busy] = await Promise.all([
      supabaseAdmin.from('profiles').select('id').in('id', ids)
        .eq('role', 'driver').eq('is_verified_driver', true).eq('driver_application_status', 'approved')
        .eq('is_blocked', false).gte('last_online_at', since),
      supabaseAdmin.from('rides').select('driver_id, status, is_scheduled, pickup_time').in('driver_id', ids).in('status', BUSY_STATUSES)
    ]);
    if (profiles.error) throw profiles.error;
    if (busy.error) throw busy.error;
    const eligible = new Set((profiles.data || []).map((row) => row.id));
    (busy.data || []).filter((row) => scheduling.keepsDriverBusy(row)).forEach((row) => eligible.delete(row.driver_id));
    const nearby = located
      .filter((row) => eligible.has(row.driver_id))
      .map((row) => ({ driverId: row.driver_id, distance: distanceMeters(coords, row) }))
      .sort((a, b) => a.distance - b.distance);
    if (nearby.length) return nearby;
  }
  return [];
};

const openToAll = async (rideId) => {
  const { error } = await supabaseAdmin.from('rides').update({ dispatch_state: 'open' }).eq('id', rideId).eq('dispatch_state', 'targeted');
  if (error) throw error;
};

/**
 * Moves a targeted ride along: keeps a live offer, expires a stale one, offers
 * the next nearest driver, or opens the ride to everyone. Safe to call often.
 */
const advanceDispatch = async (ride) => {
  if (!ride || ride.dispatch_state !== 'targeted' || ride.driver_id || !SEARCHING_STATUSES.includes(ride.status)) return;
  const now = new Date();
  const { data: offers, error } = await supabaseAdmin.from('ride_offers').select('driver_id, status, expires_at').eq('ride_id', ride.id);
  if (error) throw error;
  if ((offers || []).some((offer) => offer.status === 'pending' && new Date(offer.expires_at) > now)) return;

  const { error: expireError } = await supabaseAdmin.from('ride_offers').update({ status: 'expired' })
    .eq('ride_id', ride.id).eq('status', 'pending').lte('expires_at', now.toISOString());
  if (expireError) throw expireError;

  if ((offers || []).length >= MAX_TARGETED_OFFERS || !ride.pickup_coords) return openToAll(ride.id);
  const [next] = await findNearbyDrivers(ride.pickup_coords, new Set((offers || []).map((offer) => offer.driver_id)));
  if (!next) return openToAll(ride.id);
  const { error: offerError } = await supabaseAdmin.from('ride_offers').insert({
    ride_id: ride.id,
    driver_id: next.driverId,
    expires_at: new Date(now.getTime() + OFFER_SECONDS * 1000).toISOString()
  });
  // Another poll may have created the same offer a moment earlier.
  if (offerError && offerError.code !== '23505') throw offerError;
};

/**
 * Releases rides booked for later whose dispatch window has opened (30 minutes
 * before pickup) into normal dispatch, then moves their offers along. Called
 * lazily from polls and by the cron route. Returns how many were released.
 */
const releaseDueScheduledRides = async () => {
  const now = new Date();
  const { data, error } = await supabaseAdmin.from('rides').select('id, status, driver_id, pickup_coords, pickup_time')
    .eq('is_scheduled', true).is('dispatch_released_at', null).is('driver_id', null)
    .in('status', SEARCHING_STATUSES)
    .lte('pickup_time', new Date(now.getTime() + scheduling.DISPATCH_LEAD_MS).toISOString())
    .limit(20);
  if (error) throw error;
  for (const ride of data || []) {
    const dispatchState = ride.pickup_coords ? 'targeted' : 'open';
    const { error: releaseError } = await supabaseAdmin.from('rides')
      .update({ dispatch_released_at: now.toISOString(), dispatch_state: dispatchState })
      .eq('id', ride.id).is('dispatch_released_at', null);
    if (releaseError) throw releaseError;
    await advanceDispatch({ ...ride, dispatch_state: dispatchState });
  }
  return (data || []).length;
};

/** Pending, unexpired offers for a driver: Map of rideId -> expiresAt. */
const fetchLiveOffers = async (driverId) => {
  const { data, error } = await supabaseAdmin.from('ride_offers').select('ride_id, expires_at')
    .eq('driver_id', driverId).eq('status', 'pending').gt('expires_at', new Date().toISOString());
  if (error) throw error;
  return new Map((data || []).map((row) => [row.ride_id, row.expires_at]));
};

const setOfferStatus = async (rideId, driverId, status) => {
  const { error } = await supabaseAdmin.from('ride_offers').update({ status }).eq('ride_id', rideId).eq('driver_id', driverId).eq('status', 'pending');
  if (error) throw error;
};

module.exports = {
  H3_RESOLUTION,
  MAX_RING,
  OFFER_SECONDS,
  MAX_TARGETED_OFFERS,
  cellFor,
  distanceMeters,
  saveDriverLocation,
  findNearbyDrivers,
  advanceDispatch,
  releaseDueScheduledRides,
  fetchLiveOffers,
  setOfferStatus,
  SEARCHING_STATUSES
};
