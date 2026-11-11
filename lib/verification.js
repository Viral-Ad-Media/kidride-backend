const { randomUUID } = require('node:crypto');
const { supabaseAdmin } = require('../config/supabase');
const BUCKET = 'driver-verification';
// Documents (PDF or image), face photos (photo_*: front = selfie, left, right) and car photos (car_*).
const ORIGINAL_DOCUMENTS = ['license', 'insurance', 'registration', 'photo_front', 'photo_left', 'photo_right'];
const CAR_PHOTOS = ['car_front', 'car_back', 'car_side', 'car_plate'];
const REQUIRED_DOCUMENTS = [...ORIGINAL_DOCUMENTS, ...CAR_PHOTOS];
const isPhotoKind = (kind) => kind.startsWith('photo_') || kind.startsWith('car_');
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
// kinds: which documents must be present. Applications sent before car photos were
// asked for are reviewed against the original six.
const validateDocuments = async (userId, documents, kinds = REQUIRED_DOCUMENTS) => {
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) return false;
  for (const kind of kinds) {
    const path = documents[kind];
    if (typeof path !== 'string' || !new RegExp(`^${userId}/${kind}/[a-f0-9-]{36}$`).test(path)) return false;
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).list(`${userId}/${kind}`, { search: path.split('/').at(-1), limit: 10 });
    const item = data?.find(item => item.name === path.split('/').at(-1));
    if (error || !item || !MIME_TYPES.has(item.metadata?.mimetype) || !item.metadata?.size || item.metadata.size > 5 * 1024 * 1024 || (isPhotoKind(kind) && item.metadata.mimetype === 'application/pdf')) return false;
  }
  return true;
};
const createUpload = (userId, kind) => supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(`${userId}/${kind}/${randomUUID()}`);
// After a successful submission, delete the applicant's other uploads (failed
// attempts, earlier applications). Best-effort: a cleanup failure never fails the submit.
const removeUnusedUploads = async (userId, documents) => {
  try {
    const keep = new Set(Object.values(documents || {}));
    const stale = [];
    for (const kind of REQUIRED_DOCUMENTS) {
      const { data } = await supabaseAdmin.storage.from(BUCKET).list(`${userId}/${kind}`, { limit: 100 });
      for (const item of data || []) {
        const path = `${userId}/${kind}/${item.name}`;
        if (!keep.has(path)) stale.push(path);
      }
    }
    if (stale.length) await supabaseAdmin.storage.from(BUCKET).remove(stale);
  } catch { /* leave orphans for a later submission to clean up */ }
};
/** The documents an existing application must have: the original six plus any car photos it includes. */
const kindsIn = (documents) => [...ORIGINAL_DOCUMENTS, ...CAR_PHOTOS.filter((kind) => documents && documents[kind])];
module.exports = { BUCKET, ORIGINAL_DOCUMENTS, CAR_PHOTOS, REQUIRED_DOCUMENTS, isPhotoKind, kindsIn, MIME_TYPES, validateDocuments, createUpload, removeUnusedUploads };
