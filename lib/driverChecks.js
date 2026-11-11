const { randomUUID, randomBytes } = require('node:crypto');
const { supabaseAdmin } = require('../config/supabase');
const { BUCKET } = require('./verification');
const identity = require('./identityProvider');
const faceMatch = require('./faceMatch');
const plateReader = require('./plateReader');
const background = require('./backgroundCheck');
const { RULES, CHECK_KINDS, planChecks, expandForProvider, pickActions, onlineReasons, platesMatch, expiringDocuments, metersBetween, blocksDriving } = require('./reverification');

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
  reviewNote: row.review_note || null,
  dueAt: row.due_at || null
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

const KIND_LABELS = { identity: 'ID and selfie check', liveness: 'Face check', id_document: 'Licence photo', insurance_document: 'Insurance photo', vehicle_photo: 'Car photo', plate_photo: 'Plate photo', location_photo: 'Location photo', background: 'Background check' };
const EXPIRY_COLUMNS = { id_document: 'license_expires_on', insurance_document: 'insurance_expires_on' };

/**
 * Records an unusual event for a driver and requests the checks its rule calls for.
 * kinds overrides the rule (admin requests). Returns the checks created.
 */
const flag = async (driverId, reason, { rideId = null, details = {}, requestedBy = null, kinds = null, note = null, dueAt = null } = {}) => {
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
  const plan = expandForProvider(kinds ? { checks: kinds.filter((k) => CHECK_KINDS.includes(k)), clears: 'review' } : planChecks(reason, count), identity.isReady(), background.mode(), reason);
  if (!plan?.checks.length) return [];

  const { data: open, error: openError } = await supabaseAdmin.from('driver_checks').select('kind').eq('driver_id', driverId).in('status', ['pending', 'submitted']);
  if (openError) throw openError;
  const already = new Set((open || []).map((row) => row.kind));
  const rows = plan.checks.filter((kind) => !already.has(kind)).map((kind) => ({
    driver_id: driverId, kind, reason, ride_id: rideId, requested_by: requestedBy,
    clears: kind === 'identity' || (kind === 'background' && background.mode() === 'checkr') ? 'provider' : plan.clears,
    due_at: dueAt,
    details: { ...details, ...(note ? { note } : {}), ...(plan.repeated ? { repeatCount: count } : {}) }
  }));
  if (!rows.length) return [];
  const { data, error } = await supabaseAdmin.from('driver_checks').insert(rows).select('*');
  if (error) throw error;
  if (reason === 'spot_check') await supabaseAdmin.from('profiles').update({ last_spot_check_at: new Date().toISOString() }).eq('id', driverId);
  if (reason !== 'onboarding') {
    const list = rows.map((row) => KIND_LABELS[row.kind]).join(', ');
    const when = dueAt ? `by ${new Date(dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'before your next ride';
    await notify([{ user_id: driverId, title: 'Verification needed', body: `Please complete ${when}: ${list}. Open Verification in the app. It takes about a minute.` }]);
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
  const { data, error } = await supabaseAdmin.from('driver_checks').select('driver_id, status, clears, due_at').in('driver_id', ids).in('status', OPEN);
  if (error) throw error;
  return new Set((data || []).filter(blocksDriving).map((row) => row.driver_id));
};

/**
 * Drivers who applied before onboarding checks existed (or whose checks failed to
 * save) have none. Request them now, so no driver drives without a first face check.
 * Returns the checks created.
 */
const ensureOnboarding = async (driverId) => {
  const { data, error } = await supabaseAdmin.from('driver_checks').select('id').eq('driver_id', driverId).eq('reason', 'onboarding').limit(1);
  if (error) throw error;
  return data?.length ? [] : flag(driverId, 'onboarding');
};

/**
 * When a driver switches Online: may request checks (yearly ID renewal, far from their
 * last position, new device, long break, random spot check). Returns whether they are blocked.
 * deviceId is a random id the app keeps in local storage; position is { latitude, longitude }.
 */
const gateOnline = async (driverId, settings, { deviceId = null, position = null } = {}) => {
  const [{ data: profile, error }, { data: last }] = await Promise.all([
    supabaseAdmin.from('profiles').select('last_active_at, identity_verified_at, last_spot_check_at, known_devices').eq('id', driverId).single(),
    supabaseAdmin.from('driver_locations').select('lat, lng').eq('driver_id', driverId).maybeSingle()
  ]);
  if (error) throw error;
  await ensureOnboarding(driverId);
  // The app sends a heartbeat every minute; only a fresh switch to Online rolls the rules.
  const switchingOn = !profile.last_active_at || Date.now() - new Date(profile.last_active_at).getTime() > 5 * 60 * 1000;
  const device = typeof deviceId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(deviceId) ? deviceId : null;
  const knownDevices = Array.isArray(profile.known_devices) ? profile.known_devices : [];
  if (switchingOn) {
    const here = position && typeof position.latitude === 'number' ? { lat: position.latitude, lng: position.longitude } : null;
    const reasons = onlineReasons(settings, {
      lastOnlineAt: profile.last_active_at, identityVerifiedAt: profile.identity_verified_at, lastSpotCheckAt: profile.last_spot_check_at,
      deviceId: device, knownDevices, metersFromLastFix: here && last ? metersBetween(here, last) : null
    });
    for (const reason of reasons) await flag(driverId, reason, { details: reason === 'far_location' && here && last ? { km: Math.round(metersBetween(here, last) / 1000) } : {} });
  }
  if (device && !knownDevices.includes(device)) {
    await supabaseAdmin.from('profiles').update({ known_devices: [device, ...knownDevices].slice(0, 5) }).eq('id', driverId);
  }
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
  if (data.kind === 'identity' || data.kind === 'background') throw Object.assign(new Error('This check is done with our verification partner'), { status: 409 });
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

const download = async (path) => {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path);
  if (error) throw error;
  return data;
};

/** The driver's reference face: their first passed face check, else the licence photo from the application. */
const referenceFace = async (driverId) => {
  const { data: first } = await supabaseAdmin.from('driver_checks').select('evidence').eq('driver_id', driverId).eq('kind', 'liveness').eq('status', 'passed')
    .order('reviewed_at', { ascending: true }).limit(1).maybeSingle();
  if (first?.evidence?.neutral) return { path: first.evidence.neutral, against: 'first_face' };
  const { data: application } = await supabaseAdmin.from('driver_applications').select('documents').eq('driver_id', driverId).maybeSingle();
  return application?.documents?.license ? { path: application.documents.license, against: 'licence' } : null;
};

/**
 * Automatic checks when a provider is set up: face matching for face checks (AWS Rekognition)
 * and plate reading for plate photos (Plate Recognizer). A match on a check whose actions were
 * confirmed on the device passes it without an admin; a mismatch keeps the driver offline until
 * an admin looks. Provider errors leave the check for an admin as before.
 */
const autoVerify = async (check, evidence, details, settings) => {
  const result = { pass: false, mismatch: false, note: null, details: {} };
  try {
    if (check.kind === 'liveness' && faceMatch.isReady() && details.method === 'detected') {
      const reference = await referenceFace(check.driver_id);
      if (!reference) return result;
      const threshold = settings?.faceMatchThreshold ?? 90;
      const needed = reference.against === 'licence' ? Math.min(threshold, 80) : threshold;
      const [ref, probe] = await Promise.all([download(reference.path), download(evidence.neutral)]);
      const match = await faceMatch.compareFaces(Buffer.from(await ref.arrayBuffer()), Buffer.from(await probe.arrayBuffer()));
      result.details.faceMatch = { similarity: match.similarity, against: reference.against, threshold: needed };
      if (match.similarity >= needed) Object.assign(result, { pass: true, note: `Face matched automatically (${match.similarity}%)` });
      else Object.assign(result, { mismatch: true, note: `face similarity ${match.similarity}% (needs ${needed}%)` });
    }
    if (check.kind === 'plate_photo' && plateReader.isReady()) {
      const { data: profile } = await supabaseAdmin.from('profiles').select('vehicle').eq('id', check.driver_id).single();
      const registered = profile?.vehicle?.plate || '';
      const read = await plateReader.readPlate(await download(evidence.photo));
      result.details.plateRead = { plate: read?.plate || null, score: read?.score ?? null, registered };
      if (read && platesMatch(read.plate, registered)) Object.assign(result, { pass: true, note: `Plate read automatically: ${read.plate}` });
      else Object.assign(result, { mismatch: true, note: read ? `plate read as ${read.plate}, registered ${registered}` : 'no plate found in the photo' });
    }
  } catch (error) {
    console.warn('Automatic verification unavailable', error.message);
    result.details.autoError = 'Automatic check unavailable; review by eye';
  }
  return result;
};

/** files: { slot: path }. position: { latitude, longitude, accuracy } from the device when the photo was taken. */
const submitCheck = async (driverId, checkId, { files, position, method, expiresOn }, settings = null) => {
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
  if (EXPIRY_COLUMNS[check.kind]) {
    if (typeof expiresOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || new Date(`${expiresOn}T23:59:59Z`) < new Date()) throw Object.assign(new Error('Enter the expiry date shown on the document'), { status: 400 });
    details.expiresOn = expiresOn;
  }
  const auto = await autoVerify(check, evidence, details, settings);
  Object.assign(details, auto.details);
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('driver_checks')
    .update({
      status: auto.pass ? 'passed' : 'submitted', submitted_at: now, evidence, details,
      ...(auto.pass ? { reviewed_at: now, review_note: auto.note } : {}),
      ...(auto.mismatch ? { clears: 'review' } : {})
    })
    .eq('id', check.id).eq('status', 'pending').select('*').single();
  if (error) throw error;
  if (!auto.pass) await notifyAdmins(auto.mismatch ? 'Verification mismatch' : 'Verification to review', `${KIND_LABELS[check.kind]} ${auto.mismatch ? `did not match: ${auto.note}` : 'submitted'} (${RULES[check.reason]?.label || check.reason}).`);
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
  if (result === 'passed' && EXPIRY_COLUMNS[data.kind] && data.details?.expiresOn) {
    await supabaseAdmin.from('driver_applications').update({ [EXPIRY_COLUMNS[data.kind]]: data.details.expiresOn }).eq('driver_id', data.driver_id);
  }
  if (result === 'passed') await notify([{ user_id: data.driver_id, title: 'Verification passed', body: `Your ${KIND_LABELS[data.kind].toLowerCase()} was accepted. Thank you.` }]);
  return formatCheck(data);
};

// Background checks.
const startBackground = async (user) => {
  const current = background.mode();
  if (current === 'off') throw Object.assign(new Error('Background checks are not switched on yet'), { status: 409 });
  if (current === 'manual') return { mode: 'manual', url: null };
  const { data: profile } = await supabaseAdmin.from('profiles').select('background_candidate_id').eq('id', user.id).single();
  const { candidateId, invitationUrl } = await background.startCheckr({ candidateId: profile?.background_candidate_id, email: user.email, name: user.name });
  await supabaseAdmin.from('profiles').update({ background_candidate_id: candidateId }).eq('id', user.id);
  await supabaseAdmin.from('driver_checks').update({ status: 'submitted', submitted_at: new Date().toISOString() }).eq('driver_id', user.id).eq('kind', 'background').eq('status', 'pending');
  return { mode: 'checkr', url: invitationUrl };
};

/** Checkr result: clear passes the check; consider leaves it for an admin to decide (adjudication). */
const applyBackgroundResult = async ({ candidateId, result, reportId }) => {
  const { data: profile } = await supabaseAdmin.from('profiles').select('id').eq('background_candidate_id', candidateId).maybeSingle();
  if (!profile) return;
  const now = new Date().toISOString();
  await supabaseAdmin.from('profiles').update({ background_status: result, background_checked_at: now }).eq('id', profile.id);
  const update = result === 'clear'
    ? { status: 'passed', reviewed_at: now, review_note: `Background check clear (Checkr report ${reportId || ''})`.trim() }
    : { status: 'submitted', clears: 'review', details: { checkrReport: reportId || null, result } };
  await supabaseAdmin.from('driver_checks').update(update).eq('driver_id', profile.id).eq('kind', 'background').in('status', ['pending', 'submitted']);
  if (result !== 'clear') await notifyAdmins('Background check needs review', `A driver's background report came back "consider". Review it in Checkr, then pass or fail the check on the Verification tab.`);
};

/** Daily job: ask for a new licence or insurance photo before the current one expires. */
const runDaily = async (settings) => {
  const { data: drivers, error } = await supabaseAdmin.from('profiles').select('id, driver_applications(license_expires_on, insurance_expires_on)')
    .eq('role', 'driver').eq('driver_application_status', 'approved').eq('is_blocked', false);
  if (error) throw error;
  let requested = 0;
  for (const driver of drivers || []) {
    const application = Array.isArray(driver.driver_applications) ? driver.driver_applications[0] : driver.driver_applications;
    for (const doc of expiringDocuments(application, settings.documentReminderDays)) {
      const created = await flag(driver.id, 'document_expiring', { kinds: [doc.kind], details: { expiresOn: doc.expiresOn }, dueAt: `${doc.expiresOn}T23:59:59Z` });
      requested += created.length;
    }
  }
  return { drivers: (drivers || []).length, requested };
};

module.exports = { ensureOnboarding, startBackground, applyBackgroundResult, runDaily, flag, listForDriver, isBlocked, blockedDriverIds, gateOnline, identityState, applyIdentityResult, startIdentity, refreshIdentity, startCheck, uploadUrl, submitCheck, listForAdmin, detailForAdmin, review, formatCheck, KIND_LABELS };
