const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const {
  fetchChildrenRowsByParentId,
  fetchUserById,
  formatChild,
  insertChildRow,
  updateProfileRowById
} = require('../lib/repository');

const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');
const { createRateLimiter, parsePositiveInt } = require('../middleware/rateLimitMiddleware');
const { BUCKET, REQUIRED_DOCUMENTS, MIME_TYPES, validateDocuments, createUpload, removeUnusedUploads, isPhotoKind, kindsIn } = require('../lib/verification');

// Per-document review: { kind: { status: 'approved' | 'reupload', note, path } }. An entry only
// counts while the application still has that exact file (a new upload needs a new review).
const DOCUMENT_LABELS = { license: 'Driving licence', insurance: 'Insurance', registration: 'Vehicle registration', photo_front: 'Selfie (face front)', photo_left: 'Face, left side', photo_right: 'Face, right side', car_front: 'Car, front', car_back: 'Car, back', car_side: 'Car, side', car_plate: 'Licence plate' };
const currentReviews = (documents, reviews) => Object.fromEntries(Object.entries(reviews && typeof reviews === 'object' ? reviews : {})
  .filter(([kind, review]) => documents?.[kind] && review?.path === documents[kind] && ['approved', 'reupload'].includes(review.status))
  .map(([kind, review]) => [kind, { status: review.status, note: review.note || null }]));
const driverChecks = require('../lib/driverChecks');
const identityProvider = require('../lib/identityProvider');
const { loadSafety } = require('../lib/safetySettings');
const { normalizeSafety, DEFAULT_SAFETY } = require('../lib/safety');
const { validateCoordinates } = require('../lib/security');
const { saveDriverLocation } = require('../lib/dispatch');
const router = express.Router();

const formatUser = (user) => ({
  id: user.id,
  _id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  phone: user.phone || null,
  photoUrl: user.photoUrl || null,
  children: user.children || [],
  isVerifiedDriver: !!user.isVerifiedDriver,
  driverApplicationStatus: user.driverApplicationStatus || 'none',
  vehicle: user.vehicle || {},
  notifyEmail: user.notifyEmail !== false
});

router.get('/profile', protect, async (req, res) => {
  try {
    return res.json(formatUser(req.user));
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/profile', protect, async (req, res) => {
  try {
    const updates = {};
    const { name, phone, photoUrl, notifyEmail } = req.body;

    if (typeof name === 'string') {
      updates.name = name.trim();
    }
    if (typeof phone === 'string') {
      updates.phone = phone.trim();
    }
    if (typeof photoUrl === 'string') {
      updates.photo_url = photoUrl.trim();
    }
    if (typeof notifyEmail === 'boolean') {
      updates.notify_email = notifyEmail;
    }

    await updateProfileRowById(req.user.id, updates);
    // An approved driver changing their phone number must show their car and plate again.
    if (req.user.role === 'driver' && req.user.driverApplicationStatus === 'approved' && typeof updates.phone === 'string' && updates.phone !== (req.user.phone || '')) {
      try { await driverChecks.flag(req.user.id, 'details_changed', { details: { changed: 'phone' } }); } catch (error) { console.error('Re-verification flag failed', error); }
    }
    const updatedUser = await fetchUserById(req.user.id);
    return res.json(formatUser(updatedUser));
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/children', protect, async (req, res) => {
  try {
    const children = await fetchChildrenRowsByParentId(req.user.id);
    return res.json(children.map(formatChild));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/children', protect, async (req, res) => {
  try {
    if (req.user.role !== 'parent') return res.status(403).json({ message: 'Parent account required' });
    const { name, age, notes, photoUrl } = req.body;
    const normalizedAge = Number(age);

    if (!name || !Number.isFinite(normalizedAge) || normalizedAge <= 0) {
      return res.status(400).json({ message: 'Valid child name and age are required' });
    }

    const createdChild = await insertChildRow({
      parent_id: req.user.id,
      name: String(name).trim(),
      age: normalizedAge,
      notes: typeof notes === 'string' ? notes.trim() : null,
      photo_url: typeof photoUrl === 'string' ? photoUrl.trim() : null
    });

    const children = await fetchChildrenRowsByParentId(req.user.id);

    return res.status(201).json({
      child: formatChild(createdChild),
      children: children.map(formatChild)
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// Parents edit or remove their own children. A child with a ride in progress
// cannot be removed; a child with past rides is archived so history stays intact.
const loadOwnChild = async (req, res) => {
  if (req.user.role !== 'parent') { res.status(403).json({ message: 'Parent account required' }); return null; }
  const { data, error } = await supabaseAdmin.from('children').select('id, parent_id, archived_at').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!data || data.parent_id !== req.user.id || data.archived_at) { res.status(404).json({ message: 'Child not found' }); return null; }
  return data;
};

router.put('/children/:id', protect, async (req, res) => {
  try {
    const child = await loadOwnChild(req, res);
    if (!child) return undefined;
    const { name, age, notes } = req.body;
    const normalizedAge = Number(age);
    if (typeof name !== 'string' || !name.trim() || !Number.isFinite(normalizedAge) || normalizedAge <= 0) {
      return res.status(400).json({ message: 'Valid child name and age are required' });
    }
    const { error } = await supabaseAdmin.from('children').update({
      name: name.trim(),
      age: normalizedAge,
      notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
      updated_at: new Date().toISOString()
    }).eq('id', child.id).eq('parent_id', req.user.id);
    if (error) throw error;
    const children = await fetchChildrenRowsByParentId(req.user.id);
    return res.json({ children: children.map(formatChild) });
  } catch (error) {
    return sendError(res, error, 'Unable to update child');
  }
});

router.delete('/children/:id', protect, async (req, res) => {
  try {
    const child = await loadOwnChild(req, res);
    if (!child) return undefined;
    const { data: activeRides, error: rideError } = await supabaseAdmin.from('rides').select('id')
      .contains('child_ids', [child.id]).not('status', 'in', '(completed,cancelled)').limit(1);
    if (rideError) throw rideError;
    if (activeRides?.length) return res.status(409).json({ message: 'This child has a ride in progress. Finish or cancel it before removing them.' });
    const { data: pastRides, error: historyError } = await supabaseAdmin.from('rides').select('id').contains('child_ids', [child.id]).limit(1);
    if (historyError) throw historyError;
    // Rides reference the child, so one with history is archived rather than deleted.
    const { error } = pastRides?.length
      ? await supabaseAdmin.from('children').update({ archived_at: new Date().toISOString() }).eq('id', child.id).eq('parent_id', req.user.id)
      : await supabaseAdmin.from('children').delete().eq('id', child.id).eq('parent_id', req.user.id);
    if (error) throw error;
    const children = await fetchChildrenRowsByParentId(req.user.id);
    return res.json({ children: children.map(formatChild) });
  } catch (error) {
    return sendError(res, error, 'Unable to remove child');
  }
});

// Driver presence heartbeat: while Online the app sends { online: true } with
// the driver's position (when the browser shares it) so nearby rides can be
// offered to them; { online: false } when they switch Offline.
router.put('/me/presence', protect, async (req, res) => {
  if (req.user.role !== 'driver') return res.status(403).json({ message: 'Driver account required' });
  const online = req.body.online === true;
  try {
    // Going online may trigger a spot check, an inactivity check or a yearly ID renewal;
    // an open check keeps the driver offline until it is done.
    if (online && req.user.driverApplicationStatus === 'approved') {
      let settings;
      try { settings = await loadSafety(); } catch { settings = normalizeSafety(DEFAULT_SAFETY); }
      const here = typeof req.body.latitude === 'number' && validateCoordinates({ latitude: req.body.latitude, longitude: req.body.longitude }) ? { latitude: req.body.latitude, longitude: req.body.longitude } : null;
      // Fail closed: if the checks cannot be run, the driver stays offline.
      let blocked;
      try { blocked = await driverChecks.gateOnline(req.user.id, settings, { deviceId: req.body.deviceId, position: here }); }
      catch (error) {
        console.error('Verification gate failed; keeping driver offline', error);
        require('../lib/monitoring').captureError(error, { route: 'PUT /users/me/presence', userId: req.user.id });
        await supabaseAdmin.from('profiles').update({ last_online_at: null }).eq('id', req.user.id);
        return res.status(503).json({ message: 'We could not check your verification just now, so you are still offline. Try again in a minute.', code: 'verification_unavailable', online: false });
      }
      if (blocked) {
        await supabaseAdmin.from('profiles').update({ last_online_at: null }).eq('id', req.user.id);
        return res.status(403).json({ message: 'Complete your verification checks to go online.', code: 'verification_required', online: false });
      }
    }
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from('profiles').update({ last_online_at: online ? now : null, ...(online ? { last_active_at: now } : {}) }).eq('id', req.user.id);
    if (error) throw error;
    const position = { latitude: req.body.latitude, longitude: req.body.longitude, heading: req.body.heading };
    if (online && typeof position.latitude === 'number') {
      if (!validateCoordinates(position)) return res.status(400).json({ message: 'Invalid coordinates' });
      await saveDriverLocation(req.user.id, position);
    }
    return res.json({ online });
  } catch (error) { return sendError(res, error, 'Unable to update availability'); }
});

// A driver's own application status, so the app can show when it was submitted.
router.get('/driver-application', protect, async (req, res) => {
  if (req.user.role !== 'driver') return res.status(403).json({ message: 'Driver account required' });
  try {
    const { data, error } = await supabaseAdmin.from('driver_applications').select('*').eq('driver_id', req.user.id).maybeSingle();
    if (error) throw error;
    const reviews = currentReviews(data?.documents, data?.document_reviews);
    const rejected = req.user.driverApplicationStatus === 'rejected';
    return res.json({
      status: req.user.driverApplicationStatus || 'none',
      // After a rejection: which uploads to send again (with the admin's note), and which are already accepted.
      reupload: rejected ? Object.entries(reviews).filter(([, r]) => r.status === 'reupload').map(([kind, r]) => ({ kind, label: DOCUMENT_LABELS[kind] || kind, note: r.note })) : [],
      approvedDocuments: rejected ? Object.keys(reviews).filter((kind) => reviews[kind].status === 'approved') : [],
      submittedAt: data?.submitted_at || null,
      reviewedAt: data?.reviewed_at || null,
      reviewNote: req.user.driverApplicationStatus === 'rejected' ? data?.review_note || null : null
    });
  } catch (error) { return sendError(res, error, 'Unable to load your application'); }
});

router.post('/driver-application', protect, async (req, res) => {
  try {
    if (req.user.role !== 'driver') return res.status(403).json({ message: 'Driver account required' });
    // After a rejection, documents an admin already accepted carry over; only the rest are sent again.
    const { data: previous } = await supabaseAdmin.from('driver_applications').select('*').eq('driver_id', req.user.id).maybeSingle();
    const kept = currentReviews(previous?.documents, previous?.document_reviews);
    const carried = Object.fromEntries(Object.keys(kept).filter((kind) => kept[kind].status === 'approved').map((kind) => [kind, previous.documents[kind]]));
    const sent = req.body.documents && typeof req.body.documents === 'object' && !Array.isArray(req.body.documents) ? req.body.documents : {};
    const documents = Object.fromEntries(REQUIRED_DOCUMENTS.map((kind) => [kind, sent[kind] || carried[kind]]).filter(([, path]) => path));
    req.body.documents = documents;
    if (!await validateDocuments(req.user.id, documents)) return res.status(400).json({ message: 'Upload all required documents, face photos and car photos' });
    const { phone, vehicle, make, model, year, color, plate } = req.body;

    const incomingVehicle = vehicle && typeof vehicle === 'object'
      ? vehicle
      : { make, model, year, color, plate };

    if (typeof phone !== 'string' || !phone.trim() || !['make', 'model', 'year', 'color', 'plate'].every(key => typeof incomingVehicle[key] === 'string' && incomingVehicle[key].trim())) return res.status(400).json({ message: 'Phone and complete vehicle details required' });
    // Expiry dates (YYYY-MM-DD, in the future) so KidRide can ask for new photos before they lapse.
    const futureDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T23:59:59Z`) > new Date();
    const { licenseExpiresOn, insuranceExpiresOn } = req.body;
    if (!futureDate(licenseExpiresOn) || !futureDate(insuranceExpiresOn)) return res.status(400).json({ message: 'Enter the expiry dates of your licence and insurance' });
    const wasApproved = req.user.driverApplicationStatus === 'approved';
    const oldVehicle = req.user.vehicle || {};
    const carChanged = wasApproved && ['make', 'model', 'color', 'plate'].some((key) => String(oldVehicle[key] || '').trim().toLowerCase() !== String(incomingVehicle[key] || '').trim().toLowerCase());
    const { error: submissionError } = await supabaseAdmin.rpc('submit_driver_application', {
      applicant_id: req.user.id, application_documents: req.body.documents,
      applicant_phone: phone.trim(), applicant_vehicle: incomingVehicle
    });
    if (submissionError) throw submissionError;
    // Accepted documents that were carried over keep their review.
    const keptReviews = Object.fromEntries(Object.entries(previous?.document_reviews || {}).filter(([kind, review]) => review?.status === 'approved' && review.path === documents[kind]));
    await supabaseAdmin.from('driver_applications').update({ license_expires_on: licenseExpiresOn, insurance_expires_on: insuranceExpiresOn }).eq('driver_id', req.user.id);
    const { error: reviewsError } = await supabaseAdmin.from('driver_applications').update({ document_reviews: keptReviews }).eq('driver_id', req.user.id);
    if (reviewsError) console.warn('Document reviews not saved (run test_run_fixes.sql)', reviewsError.message);
    await removeUnusedUploads(req.user.id, req.body.documents);
    if (carChanged) { try { await driverChecks.flag(req.user.id, 'details_changed', { details: { changed: 'vehicle' } }); } catch (error) { console.error('Re-verification flag failed', error); } }
    // New applicants verify their identity and do a first face check (the reference for later checks).
    try { await driverChecks.flag(req.user.id, 'onboarding'); } catch (error) { console.error('Onboarding checks not created', error); }

    const updatedUser = await fetchUserById(req.user.id);

    return res.json({
      message: 'Driver application submitted successfully',
      user: formatUser(updatedUser)
    });
  } catch (error) {
    return sendError(res, error);
  }
});


// Signed upload URLs per account: six documents per application plus retries.
const uploadLimiter = createRateLimiter({
  windowMs: parsePositiveInt(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
  max: parsePositiveInt(process.env.UPLOAD_RATE_LIMIT_MAX_REQUESTS, 30),
  message: 'Too many upload requests. Please try again later.',
  keyPrefix: 'upload',
  keyGenerator: (req) => req.user?.id
});

router.post('/verification-upload', protect, uploadLimiter, async (req, res) => {
  if (req.user.role !== 'driver') return res.status(403).json({ message: 'Driver account required' });
  if (!REQUIRED_DOCUMENTS.includes(req.body.kind) || !MIME_TYPES.has(req.body.contentType) || (isPhotoKind(req.body.kind) && req.body.contentType === 'application/pdf')) return res.status(400).json({ message: 'Invalid document type' });
  try {
    const { data, error } = await createUpload(req.user.id, req.body.kind);
    if (error) throw error;
    return res.json({ path: data.path, signedUrl: data.signedUrl });
  } catch { return res.status(503).json({ message: 'Document upload unavailable' }); }
});

router.post('/push-token', protect, async (req, res) => {
  const { token, platform } = req.body;
  if (typeof token !== 'string' || !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(token) || !['ios', 'android'].includes(platform)) return res.status(400).json({ message: 'Invalid push token' });
  const { error } = await supabaseAdmin.from('push_tokens').upsert({ token, user_id: req.user.id, platform }, { onConflict: 'token' });
  return error ? res.status(503).json({ message: 'Notifications unavailable' }) : res.json({ registered: true });
});
router.delete('/push-token', protect, async (req, res) => {
  const { error } = await supabaseAdmin.from('push_tokens').delete().eq('token', req.body.token).eq('user_id', req.user.id);
  return error ? res.status(503).json({ message: 'Notifications unavailable' }) : res.json({ removed: true });
});

router.get('/driver-applications', protect, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin required' });
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ message: 'Invalid status filter' });
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, name, email, phone, vehicle, driver_application_status, driver_applications(submitted_at)')
      .eq('role', 'driver')
      .eq('driver_application_status', status)
      .order('updated_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return res.json((data || []).map((row) => {
      const application = Array.isArray(row.driver_applications) ? row.driver_applications[0] : row.driver_applications;
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone || null,
        vehicle: (row.vehicle && typeof row.vehicle === 'object') ? row.vehicle : {},
        driverApplicationStatus: row.driver_application_status,
        submittedAt: application?.submitted_at || null
      };
    }));
  } catch (error) { return sendError(res, error, 'Unable to load driver applications'); }
});

router.get('/driver-applications/:id', protect, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin required' });
  try {
    const { data, error } = await supabaseAdmin.from('driver_applications').select('*').eq('driver_id', req.params.id).single();
    if (error) throw error;
    // One batch call instead of one storage round trip per document.
    const entries = Object.entries(data.documents);
    const { data: urls, error: signingError } = await supabaseAdmin.storage.from(BUCKET).createSignedUrls(entries.map(([, path]) => path), 300);
    if (signingError) throw signingError;
    const documents = {};
    entries.forEach(([kind], index) => {
      if (!urls[index]?.signedUrl) throw new Error('Document link unavailable');
      documents[kind] = urls[index].signedUrl;
    });
    return res.json({ documents, submittedAt: data.submitted_at, reviews: currentReviews(data.documents, data.document_reviews), labels: DOCUMENT_LABELS });
  } catch { return res.status(404).json({ message: 'Application unavailable' }); }
});

// Per-document decision on a pending application: approve it, or ask for it again (with a note).
router.put('/driver-applications/:id/documents/:kind', protect, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin required' });
  const { status } = req.body;
  if (!['approved', 'reupload', 'clear'].includes(status)) return res.status(400).json({ message: 'Invalid document decision' });
  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
  try {
    const user = await fetchUserById(req.params.id);
    if (!user || user.role !== 'driver' || user.driverApplicationStatus !== 'pending') return res.status(409).json({ message: 'Pending driver application required' });
    const { data, error } = await supabaseAdmin.from('driver_applications').select('*').eq('driver_id', user.id).single();
    if (error) throw error;
    const path = data.documents?.[req.params.kind];
    if (!path) return res.status(404).json({ message: 'Document not in this application' });
    const reviews = { ...(data.document_reviews || {}) };
    if (status === 'clear') delete reviews[req.params.kind];
    else reviews[req.params.kind] = { status, note: status === 'reupload' ? note || null : null, path, by: req.user.id, at: new Date().toISOString() };
    const { error: updateError } = await supabaseAdmin.from('driver_applications').update({ document_reviews: reviews }).eq('driver_id', user.id).eq('submitted_at', data.submitted_at);
    if (updateError) throw updateError;
    return res.json({ reviews: currentReviews(data.documents, reviews) });
  } catch (error) { return sendError(res, error, 'Unable to save the document decision'); }
});
router.put('/driver-applications/:id/review', protect, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin required' });
  if (!['approved', 'rejected'].includes(req.body.status)) return res.status(400).json({ message: 'Invalid review status' });
  try {
    const user = await fetchUserById(req.params.id);
    if (!user || user.role !== 'driver' || user.driverApplicationStatus !== 'pending') return res.status(409).json({ message: 'Pending driver application required' });
    const { data, error } = await supabaseAdmin.from('driver_applications').select('*').eq('driver_id', user.id).single();
    if (error || !await validateDocuments(user.id, data?.documents, kindsIn(data?.documents))) return res.status(400).json({ message: 'Application documents missing' });
    const reviews = currentReviews(data.documents, data.document_reviews);
    const reupload = Object.keys(reviews).filter((kind) => reviews[kind].status === 'reupload');
    if (req.body.status === 'approved' && reupload.length) return res.status(409).json({ message: 'Some documents are marked "upload again". Clear them or send the application back.' });
    // Operator approval must follow the operator's actual background-check process.
    if (typeof req.body.submittedAt !== 'string') return res.status(400).json({ message: 'Review the current documents and include submittedAt' });
    if (req.body.status === 'approved' && identityProvider.isReady() && (await driverChecks.identityState(user.id)).status !== 'verified') {
      return res.status(409).json({ message: 'This driver has not passed ID verification yet' });
    }
    const { data: updated, error: updateError } = await supabaseAdmin.rpc('review_driver_application', {
      applicant_id: user.id, reviewed_submission: req.body.submittedAt, review_status: req.body.status
    });
    if (updateError) throw updateError;
    if (!updated) return res.status(409).json({ message: 'Application changed; refresh first' });
    // Record when it was decided and, for a rejection, why (shown to the driver).
    let reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (req.body.status === 'rejected' && !reason && reupload.length) reason = `Please upload again: ${reupload.map((kind) => DOCUMENT_LABELS[kind] || kind).join(', ')}.`;
    await supabaseAdmin.from('driver_applications').update({ reviewed_at: new Date().toISOString(), review_note: req.body.status === 'rejected' && reason ? reason : null }).eq('driver_id', user.id);
    // Applicants from before onboarding checks existed still get their ID and first face check.
    if (req.body.status === 'approved') { try { await driverChecks.ensureOnboarding(user.id); } catch (checkError) { console.error('Onboarding checks not created on approval', checkError); } }
    return res.json({ status: req.body.status });
  } catch (error) { console.error('Review failed', error); return res.status(500).json({ message: 'Unable to review application' }); }
});

module.exports = router;
