const { supabaseAdmin } = require('../config/supabase');
const { RIDE_SELECT } = require('./repository');
const { notifyRideEvent } = require('./notifications');
const { outranks } = require('./safety');

// Safety incidents on a ride (SOS, wrong trip codes, off route, stopped): one
// row each in ride_incidents, the most serious open one flagged on the ride for
// admin lists, and the parent and admins notified.

const formatIncident = (row) => ({
  id: row.id,
  rideId: row.ride_id,
  kind: row.kind,
  reporterRole: row.reporter_role,
  location: row.location || null,
  details: row.details || {},
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
  contactsNotified: row.contacts_notified ?? null,
  liveLinkExpiresAt: row.share_expires_at || null
});

/** ride is a RIDE_SELECT row. Returns { incident, ride } with the ride re-read when its flag changed. */
// `columns` are extra ride_incidents columns; `notify` is added to what the
// notifications see but not stored in details.
const recordIncident = async (ride, kind, { userId = null, role = 'system', location = null, details = {}, columns = {}, notify = {} } = {}) => {
  const { data, error } = await supabaseAdmin.from('ride_incidents')
    .insert({ ...columns, ride_id: ride.id, kind, reported_by: userId, reporter_role: role, location, details })
    .select(INCIDENT_COLUMNS).single();
  if (error) throw error;
  let updated = ride;
  if (outranks(kind, ride.safety_alert)) {
    const { data: flagged, error: flagError } = await supabaseAdmin.from('rides')
      .update({ safety_alert: kind, safety_alert_at: data.created_at }).eq('id', ride.id).select(RIDE_SELECT).maybeSingle();
    if (flagError) console.warn('Safety flag not saved', flagError.message);
    if (flagged) updated = flagged;
  }
  await notifyRideEvent(updated, kind, { ...details, ...notify, reporterRole: role, at: data.created_at });
  return { incident: formatIncident(data), ride: updated };
};

const INCIDENT_COLUMNS = 'id, ride_id, kind, reporter_role, location, details, created_at, resolved_at, contacts_notified, share_expires_at';

const listIncidents = async (rideId) => {
  const { data, error } = await supabaseAdmin.from('ride_incidents').select(INCIDENT_COLUMNS).eq('ride_id', rideId).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data || []).map(formatIncident);
};

/** Admin: closes every open incident on the ride and clears its flag. */
const resolveIncidents = async (rideId, adminId) => {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('ride_incidents').update({ resolved_at: now, resolved_by: adminId }).eq('ride_id', rideId).is('resolved_at', null);
  if (error) throw error;
  const { data, error: rideError } = await supabaseAdmin.from('rides').update({ safety_alert: null, safety_alert_at: null }).eq('id', rideId).select(RIDE_SELECT).maybeSingle();
  if (rideError) throw rideError;
  return data;
};

/**
 * Admin incident history across rides, newest first. `status` is open | all;
 * `kind` narrows to one kind. Each row carries enough of the ride to act on.
 */
const listAllIncidents = async ({ status = 'open', kind = null, limit = 100 } = {}) => {
  let query = supabaseAdmin.from('ride_incidents')
    .select(`${INCIDENT_COLUMNS}, resolved_by, ride:rides!inner (id, status, pickup_location, dropoff_location, parent:profiles!rides_parent_id_fkey (name, phone), driver:profiles!rides_driver_id_fkey (name, phone), child_id)`)
    .order('created_at', { ascending: false }).limit(Math.min(Math.max(Number(limit) || 100, 1), 200));
  if (status === 'open') query = query.is('resolved_at', null);
  if (kind) query = query.eq('kind', kind);
  const { data, error } = await query;
  if (error) throw error;
  // rides.child_id is text with no foreign key, so names come in a second query.
  const childIds = [...new Set((data || []).map((row) => row.ride?.child_id).filter(Boolean))];
  const { data: children } = childIds.length
    ? await supabaseAdmin.from('children').select('id, name').in('id', childIds)
    : { data: [] };
  const childNames = new Map((children || []).map((c) => [String(c.id), c.name]));
  return (data || []).map((row) => ({
    ...formatIncident(row),
    ride: row.ride ? {
      id: row.ride.id,
      status: row.ride.status,
      pickup: row.ride.pickup_location,
      dropoff: row.ride.dropoff_location,
      child: childNames.get(String(row.ride.child_id)) || null,
      parent: row.ride.parent ? { name: row.ride.parent.name, phone: row.ride.parent.phone || null } : null,
      driver: row.ride.driver ? { name: row.ride.driver.name, phone: row.ride.driver.phone || null } : null
    } : null
  }));
};

module.exports = { recordIncident, listIncidents, listAllIncidents, resolveIncidents, formatIncident, INCIDENT_COLUMNS };
