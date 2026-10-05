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
const { BUCKET, REQUIRED_DOCUMENTS, MIME_TYPES, validateDocuments, createUpload } = require('../lib/verification');
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
    return res.status(500).json({ message: error.message });
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
    return res.status(500).json({ message: error.message });
  }
});

router.get('/children', protect, async (req, res) => {
  try {
    const children = await fetchChildrenRowsByParentId(req.user.id);
    return res.json(children.map(formatChild));
  } catch (error) {
    return res.status(500).json({ message: error.message });
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
    return res.status(500).json({ message: error.message });
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

    const updatedUser = await fetchUserById(req.user.id);

    return res.json({
      message: 'Driver application submitted successfully',
      user: formatUser(updatedUser)
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});


router.post('/verification-upload', protect, async (req, res) => {
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

router.get('/driver-applications/:id', protect, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin required' });
  try {
    const { data, error } = await supabaseAdmin.from('driver_applications').select('documents, submitted_at').eq('driver_id', req.params.id).single();
    if (error) throw error;
    const documents = {};
    for (const [kind, path] of Object.entries(data.documents)) {
      const { data: url, error: signingError } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 300);
      if (signingError) throw signingError;
      documents[kind] = url.signedUrl;
    }
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
