const { randomUUID, randomBytes } = require('node:crypto');
const { supabaseAdmin } = require('../config/supabase');
const { BUCKET } = require('./verification');
const identity = require('./identityProvider');
const { RULES, CHECK_KINDS, planChecks, expandForProvider, pickActions, onlineReason, metersBetween, blocksDriving } = require('./reverification');

// Driver re-verification in the database: driver_flags (every unusual event,
// counted for the repeat rules) and driver_checks (what the driver must do).
// Rules live in lib/reverification.js. Nothing here throws into a ride update:
// callers wrap flag() in their `safely` helper.

const OPEN = ['pending', 'submitted', 'failed'];
const CHALLENGE_MS = 5 * 60 * 1000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

const formatCheck = (row) => ({
  id: row.id,
  driverId: row.driver_id,
  kind: row.kind,
  reason: row.reason,
  reasonLabel: RULES[row.reason]?.label || row.reason,
  clears: row.clears,
  status: row.status,
  rideId: row.ride_id || null,
  details: row.details || {},
  blocksDriving: blocksDriving(row),
  createdAt: row.created_at,
  submittedAt: row.submitted_at || null,
  reviewedAt: row.reviewed_at || null,
  reviewNote: row.review_note || null
});

const notify = async (rows) => {
  if (!rows.length) return;
  const { error } = await supabaseAdmin.from('notifications').insert(rows.map((row) => ({ kind: 'verification', ...row, title: row.title.slice(0, 120), body: row.body.slice(0, 400) })));
  if (error) console.warn('Verification notification not saved', error.message);
};
const notifyAdmins = async (title, body) => {
  const { data } = await supabaseAdmin.from('profiles').select('id').eq('role', 'admin').eq('is_blocked', false);
  await notify((data || []).map((admin) => ({ user_id: admin.id, title, body })));
};

const KIND_LABELS = { identity: 'ID and selfie check', liveness: 'Face check', id_document: 'Licence photo', vehicle_photo: 'Car photo', plate_photo: 'Plate photo', location_photo: 'Location photo' };

/**
 * Records an unusual event for a driver and requests the checks its rule calls for.
 * kinds overrides the rule (admin requests). Returns the checks created.
 */
const flag = async (driverId, reason, { rideId = null, details = {}, requestedBy = null, kinds = null, note = null } = {}) => {
  const rule = RULES[reason];
  if (!rule || !driverId) return [];
  const { error: flagError } = await supabaseAdmin.from('driver_flags').insert({ driver_id: driverId, reason, ride_id: rideId, details });
  if (flagError) throw flagError;
  let count = 1;
  if (rule.repeat) {
    const since = new Date(Date.now() - rule.repeat.days * 86400000).toISOString();
    const { count: recent, error } = await supabaseAdmin.from('driver_flags').select('id', { count: 'exact', head: true }).eq('driver_id', driverId).eq('reason', reason).gte('created_at', since);
    if (error) throw error;
    count = recent || 1;
  }
  const plan = expandForProvider(kinds ? { checks: kinds.filter((k) => CHECK_KINDS.includes(k)), clears: 'review' } : planChecks(reason, count), identity.isReady());
  if (!plan?.checks.length) return [];

  const { data: open, error: openError } = await supabaseAdmin.from('driver_checks').select('kind').eq('driver_id', driverId).in('status', ['pending', 'submitted']);
  if (openError) throw openError;
  const already = new Set((open || []).map((row) => row.kind));
  const rows = plan.checks.filter((kind) => !already.has(kind)).map((kind) => ({
    driver_id: driverId, kind, reason, ride_id: rideId, requested_by: requestedBy,
    clears: kind === 'identity' ? 'provider' : plan.clears,
    details: { ...details, ...(note ? { note } : {}), ...(plan.repeated ? { repeatCount: count } : {}) }
  }));
  if (!rows.length) return [];
  const { data, error } = await supabaseAdmin.from('driver_checks').insert(rows).select('*');
  if (error) throw error;
  if (reason === 'spot_check') await supabaseAdmin.from('profiles').update({ last_spot_check_at: new Date().toISOString() }).eq('id', driverId);
  if (reason !== 'onboarding') {
    const list = rows.map((row) => KIND_LABELS[row.kind]).join(', ');
    await notify([{ user_id: driverId, title: 'Verification needed', body: `Before your next ride, please complete: ${list}. Open Verification in the app. It takes about a minute.` }]);
    await notifyAdmins('Driver re-verification requested', `${rule.label}. Checks requested: ${list}.`);
  }
  return (data || []).map(formatCheck);
};

/** Open checks for a driver, newest first, plus the last few closed ones. */
const listForDriver = async (driverId) => {
  const { data, error } = await supabaseAdmin.from('driver_checks').select('*').eq('driver_id', driverId).order('created_at', { ascending: false }).limit(30);
  if (error) throw error;
  return (data || []).map(formatCheck);
};

const isBlocked = async (driverId) => (await listForDriver(driverId)).some((check) => check.blocksDriving);

/** Drivers among ids that have a check stopping new rides. */
const blockedDriverIds = async (ids) => {
  if (!ids.length) return new Set();
  const { data, error } = await supabaseAdmin.from('driver_checks').select('driver_id, status, clears').in('driver_id', ids).in('status', OPEN);
  if (error) throw error;
  return new Set((data || []).filter(blocksDriving).map((row) => row.driver_id));
};

/** When a driver switches Online: may request a spot check, inactivity or renewal check. Returns whether they are blocked. */
const gateOnline = async (driverId, settings) => {
  const { data: profile, error } = await supabaseAdmin.from('profiles').select('last_active_at, identity_verified_at, last_spot_check_at').eq('id', driverId).single();
  if (error) throw error;
  // The app sends a heartbeat every minute; only a fresh switch to Online rolls the rules.
  const switchingOn = !profile.last_active_at || Date.now() - new Date(profile.last_active_at).getTime() > 5 * 60 * 1000;
  const reason = switchingOn && onlineReason(settings, { lastOnlineAt: profile.last_active_at, identityVerifiedAt: profile.identity_verified_at, lastSpotCheckAt: profile.last_spot_check_at });
  if (reason) await flag(driverId, reason);
  return isBlocked(driverId);
};

// Identity (provider) results.
const identityState = async (driverId) => {
  const { data, error } = await supabaseAdmin.from('profiles').select('identity_status, identity_verified_at, identity_error, identity_session_id').eq('id', driverId).single();
  if (error) throw error;
  return { status: data.identity_status || 'none', verifiedAt: data.identity_verified_at || null, error: data.identity_error || null, sessionId: data.identity_session_id || null, providerReady: identity.isReady() };
};

const applyIdentityResult = async (driverId, result) => {
  const status = result.status === 'canceled' ? 'none' : result.status;
  const now = new Date().toISOString();
  const update = { identity_status: status, identity_error: result.error, ...(status === 'verified' ? { identity_verified_at: now } : {}) };
  const { error } = await supabaseAdmin.from('profiles').update(update).eq('id', driverId).eq('identity_session_id', result.sessionId);
  if (error) throw error;
  if (status === 'verified') {
    await supabaseAdmin.from('driver_checks').update({ status: 'passed', reviewed_at: now, review_note: 'Verified by the identity provider' })
      .eq('driver_id', driverId).eq('kind', 'identity').in('status', ['pending', 'submitted']);
  } else if (status === 'processing') {
    await supabaseAdmin.from('driver_checks').update({ status: 'submitted', submitted_at: now }).eq('driver_id', driverId).eq('kind', 'identity').eq('status', 'pending');
  } else if (status === 'requires_input') {
    await supabaseAdmin.from('driver_checks').update({ status: 'pending' }).eq('driver_id', driverId).eq('kind', 'identity').eq('status', 'submitted');
  }
  return status;
};

const startIdentity = async (user, returnUrl) => {
  const session = await identity.createSession({ driverId: user.id, email: user.email, returnUrl });
  const { error } = await supabaseAdmin.from('profiles').update({ identity_session_id: session.sessionId, identity_status: 'pending', identity_error: null }).eq('id', user.id);
  if (error) throw error;
  return session.url;
};

const refreshIdentity = async (driverId) => {
  const state = await identityState(driverId);
  if (!state.sessionId || !identity.isReady()) return state;
  const result = await identity.fetchSession(state.sessionId);
  await applyIdentityResult(driverId, result);
  return identityState(driverId);
};

// Evidence for a photo or face check.
const loadOwnCheck = async (driverId, checkId) => {
  const { data, error } = await supabaseAdmin.from('driver_checks').select('*').eq('id', checkId).eq('driver_id', driverId).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Check not found'), { status: 404 });
  if (data.kind === 'identity') throw Object.assign(new Error('Identity checks are done with the identity provider'), { status: 409 });
  if (data.status !== 'pending') throw Object.assign(new Error('This check is already done'), { status: 409 });
  return data;
};

const slotsFor = (check) => (check.kind === 'liveness' ? ['neutral', ...(check.challenge?.actions || [])] : ['photo']);

/** A fresh random set of face actions; the evidence must be uploaded before it expires. */
const startCheck = async (driverId, checkId) => {
  const check = await loadOwnCheck(driverId, checkId);
  const challenge = check.kind === 'liveness'
    ? { actions: pickActions(), nonce: randomBytes(8).toString('hex'), expiresAt: new Date(Date.now() + CHALLENGE_MS).toISOString() }
    : { nonce: randomBytes(8).toString('hex'), expiresAt: new Date(Date.now() + CHALLENGE_MS).toISOString() };
  const { error } = await supabaseAdmin.from('driver_checks').update({ challenge }).eq('id', check.id);
  if (error) throw error;
  return { checkId: check.id, kind: check.kind, ...challenge };
};

const uploadUrl = async (driverId, checkId, slot, contentType) => {
  const check = await loadOwnCheck(driverId, checkId);
  if (!check.challenge || new Date(check.challenge.expiresAt) < new Date()) throw Object.assign(new Error('This check timed out. Start it again.'), { status: 409 });
  if (!slotsFor(check).includes(slot) || !IMAGE_TYPES.has(contentType)) throw Object.assign(new Error('Invalid photo'), { status: 400 });
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(`${driverId}/checks/${check.id}/${slot}-${randomUUID()}`);
  if (error) throw error;
  return { path: data.path, signedUrl: data.signedUrl };
};

/** files: { slot: path }. position: { latitude, longitude, accuracy } from the device when the photo was taken. */
const submitCheck = async (driverId, checkId, { files, position, method }) => {
  const check = await loadOwnCheck(driverId, checkId);
  if (!check.challenge || new Date(check.challenge.expiresAt) < new Date()) throw Object.assign(new Error('This check timed out. Start it again.'), { status: 409 });
  const slots = slotsFor(check);
  if (!files || typeof files !== 'object') throw Object.assign(new Error('Photos missing'), { status: 400 });
  const { data: stored, error: listError } = await supabaseAdmin.storage.from(BUCKET).list(`${driverId}/checks/${check.id}`, { limit: 100 });
  if (listError) throw listError;
  const byName = new Map((stored || []).map((item) => [item.name, item]));
  const evidence = {};
  for (const slot of slots) {
    const path = files[slot];
    const name = typeof path === 'string' && path.startsWith(`${driverId}/checks/${check.id}/${slot}-`) ? path.split('/').at(-1) : null;
    const item = name && byName.get(name);
    if (!item || !IMAGE_TYPES.has(item.metadata?.mimetype) || !(item.metadata?.size > 0)) throw Object.assign(new Error('Take every photo before sending'), { status: 400 });
    evidence[slot] = path;
  }
  const details = { ...(check.details || {}), method: method === 'detected' ? 'detected' : 'manual' };
  if (check.kind === 'liveness') details.actions = check.challenge.actions;
  const hasPosition = position && typeof position.latitude === 'number' && typeof position.longitude === 'number';
  if (check.kind === 'location_photo' && !hasPosition) throw Object.assign(new Error('Allow location so we can see where the photo was taken'), { status: 400 });
  if (hasPosition) {
    details.position = { lat: position.latitude, lng: position.longitude, accuracy: typeof position.accuracy === 'number' ? Math.round(position.accuracy) : null };
    const { data: last } = await supabaseAdmin.from('driver_locations').select('lat, lng, updated_at').eq('driver_id', driverId).maybeSingle();
    if (last) {
      details.metersFromLastFix = Math.round(metersBetween(details.position, last));
      details.lastFixAt = last.updated_at;
    }
  }
  const { data, error } = await supabaseAdmin.from('driver_checks')
    .update({ status: 'submitted', submitted_at: new Date().toISOString(), evidence, details })
    .eq('id', check.id).eq('status', 'pending').select('*').single();
  if (error) throw error;
  await notifyAdmins('Verification to review', `${KIND_LABELS[check.kind]} submitted (${RULES[check.reason]?.label || check.reason}).`);
  return formatCheck(data);
};

// Admin side.
const listForAdmin = async (status) => {
  let query = supabaseAdmin.from('driver_checks').select('*, driver:profiles!driver_checks_driver_id_fkey(id, name, email, vehicle)').order('created_at', { ascending: false }).limit(200);
  if (status === 'submitted') query = query.eq('status', 'submitted');
  else if (status === 'open') query = query.in('status', OPEN);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((row) => ({ ...formatCheck(row), driver: row.driver ? { id: row.driver.id, name: row.driver.name, email: row.driver.email, vehicle: row.driver.vehicle || {} } : null }));
};

/** One check with short-lived links to its photos and to the driver's reference photos. */
const detailForAdmin = async (checkId) => {
  const { data: check, error } = await supabaseAdmin.from('driver_checks').select('*').eq('id', checkId).single();
  if (error) throw error;
  const [{ data: application }, { data: reference }] = await Promise.all([
    supabaseAdmin.from('driver_applications').select('documents').eq('driver_id', check.driver_id).maybeSingle(),
    supabaseAdmin.from('driver_checks').select('evidence').eq('driver_id', check.driver_id).eq('kind', 'liveness').eq('status', 'passed').order('reviewed_at', { ascending: true }).limit(1).maybeSingle()
  ]);
  const refs = {};
  const docs = application?.documents || {};
  ['license', 'photo_front'].forEach((kind) => { if (docs[kind]) refs[kind] = docs[kind]; });
  if (reference?.evidence?.neutral) refs.first_face = reference.evidence.neutral;
  const sign = async (paths) => {
    const entries = Object.entries(paths || {});
    if (!entries.length) return {};
    const { data: urls, error: signError } = await supabaseAdmin.storage.from(BUCKET).createSignedUrls(entries.map(([, path]) => path), 300);
    if (signError) throw signError;
    return Object.fromEntries(entries.map(([key], index) => [key, urls[index]?.signedUrl || null]));
  };
  const { data: driver } = await supabaseAdmin.from('profiles').select('name, email, vehicle, identity_status, identity_verified_at').eq('id', check.driver_id).single();
  return { check: formatCheck(check), evidence: await sign(check.evidence), reference: await sign(refs), driver };
};

const review = async (checkId, adminId, result, note) => {
  const { data, error } = await supabaseAdmin.from('driver_checks')
    .update({ status: result, reviewed_at: new Date().toISOString(), reviewed_by: adminId, review_note: note || null })
    .eq('id', checkId).in('status', result === 'cancelled' ? ['pending', 'submitted', 'failed'] : ['submitted', 'pending']).select('*').maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('This check changed; refresh first'), { status: 409 });
  if (result === 'failed') await notify([{ user_id: data.driver_id, title: 'Verification not passed', body: `Your ${KIND_LABELS[data.kind].toLowerCase()} was not accepted${note ? `: ${note}` : ''}. KidRide support will contact you before you can take rides again.` }]);
  if (result === 'passed') await notify([{ user_id: data.driver_id, title: 'Verification passed', body: `Your ${KIND_LABELS[data.kind].toLowerCase()} was accepted. Thank you.` }]);
  return formatCheck(data);
};

module.exports = { flag, listForDriver, isBlocked, blockedDriverIds, gateOnline, identityState, applyIdentityResult, startIdentity, refreshIdentity, startCheck, uploadUrl, submitCheck, listForAdmin, detailForAdmin, review, formatCheck, KIND_LABELS };
