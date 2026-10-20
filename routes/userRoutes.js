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
const { BUCKET, REQUIRED_DOCUMENTS, MIME_TYPES, validateDocuments, createUpload, removeUnusedUploads } = require('../lib/verification');
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
  vehicle: user.vehicle || {}
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
    const { name, phone, photoUrl } = req.body;

    if (typeof name === 'string') {
      updates.name = name.trim();
    }
    if (typeof phone === 'string') {
      updates.phone = phone.trim();
    }
    if (typeof photoUrl === 'string') {
      updates.photo_url = photoUrl.trim();
    }

    await updateProfileRowById(req.user.id, updates);
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

router.post('/driver-application', protect, async (req, res) => {
  try {
    if (req.user.role !== 'driver') return res.status(403).json({ message: 'Driver account required' });
    if (!await validateDocuments(req.user.id, req.body.documents)) return res.status(400).json({ message: 'Upload all required verification documents and photos' });
    const { phone, vehicle, make, model, year, color, plate } = req.body;

    const incomingVehicle = vehicle && typeof vehicle === 'object'
      ? vehicle
      : { make, model, year, color, plate };

    if (typeof phone !== 'string' || !phone.trim() || !['make', 'model', 'year', 'color', 'plate'].every(key => typeof incomingVehicle[key] === 'string' && incomingVehicle[key].trim())) return res.status(400).json({ message: 'Phone and complete vehicle details required' });
    const { error: submissionError } = await supabaseAdmin.rpc('submit_driver_application', {
      applicant_id: req.user.id, application_documents: req.body.documents,
      applicant_phone: phone.trim(), applicant_vehicle: incomingVehicle
    });
    if (submissionError) throw submissionError;
    await removeUnusedUploads(req.user.id, req.body.documents);

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
  if (!REQUIRED_DOCUMENTS.includes(req.body.kind) || !MIME_TYPES.has(req.body.contentType) || (req.body.kind.startsWith('photo_') && req.body.contentType === 'application/pdf')) return res.status(400).json({ message: 'Invalid document type' });
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
    const { data, error } = await supabaseAdmin.from('driver_applications').select('documents, submitted_at').eq('driver_id', req.params.id).single();
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
    return res.json({ documents, submittedAt: data.submitted_at });
  } catch { return res.status(404).json({ message: 'Application unavailable' }); }
});
router.put('/driver-applications/:id/review', protect, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin required' });
  if (!['approved', 'rejected'].includes(req.body.status)) return res.status(400).json({ message: 'Invalid review status' });
  try {
    const user = await fetchUserById(req.params.id);
    if (!user || user.role !== 'driver' || user.driverApplicationStatus !== 'pending') return res.status(409).json({ message: 'Pending driver application required' });
    const { data, error } = await supabaseAdmin.from('driver_applications').select('documents').eq('driver_id', user.id).single();
    if (error || !await validateDocuments(user.id, data?.documents)) return res.status(400).json({ message: 'Application documents missing' });
    // Operator approval must follow the operator's actual background-check process.
    if (typeof req.body.submittedAt !== 'string') return res.status(400).json({ message: 'Review the current documents and include submittedAt' });
    const { data: updated, error: updateError } = await supabaseAdmin.rpc('review_driver_application', {
      applicant_id: user.id, reviewed_submission: req.body.submittedAt, review_status: req.body.status
    });
    if (updateError) throw updateError;
    if (!updated) return res.status(409).json({ message: 'Application changed; refresh first' });
    return res.json({ status: req.body.status });
  } catch { return res.status(500).json({ message: 'Unable to review application' }); }
});

module.exports = router;
