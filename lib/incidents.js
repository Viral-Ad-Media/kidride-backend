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
  resolvedAt: row.resolved_at
});

/** ride is a RIDE_SELECT row. Returns { incident, ride } with the ride re-read when its flag changed. */
const recordIncident = async (ride, kind, { userId = null, role = 'system', location = null, details = {} } = {}) => {
  const { data, error } = await supabaseAdmin.from('ride_incidents')
    .insert({ ride_id: ride.id, kind, reported_by: userId, reporter_role: role, location, details })
    .select('*').single();
  if (error) throw error;
  let updated = ride;
  if (outranks(kind, ride.safety_alert)) {
    const { data: flagged, error: flagError } = await supabaseAdmin.from('rides')
      .update({ safety_alert: kind, safety_alert_at: data.created_at }).eq('id', ride.id).select(RIDE_SELECT).maybeSingle();
    if (flagError) console.warn('Safety flag not saved', flagError.message);
    if (flagged) updated = flagged;
  }
  await notifyRideEvent(updated, kind, { ...details, reporterRole: role, at: data.created_at });
  return { incident: formatIncident(data), ride: updated };
};

const listIncidents = async (rideId) => {
  const { data, error } = await supabaseAdmin.from('ride_incidents').select('*').eq('ride_id', rideId).order('created_at', { ascending: false }).limit(50);
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

module.exports = { recordIncident, listIncidents, resolveIncidents, formatIncident };
