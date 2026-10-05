const { randomUUID } = require('node:crypto');
const { supabaseAdmin } = require('../config/supabase');
const BUCKET = 'driver-verification';
const REQUIRED_DOCUMENTS = ['license', 'insurance', 'registration', 'photo_front', 'photo_left', 'photo_right'];
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const validateDocuments = async (userId, documents) => {
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) return false;
  for (const kind of REQUIRED_DOCUMENTS) {
    const path = documents[kind];
    if (typeof path !== 'string' || !new RegExp(`^${userId}/${kind}/[a-f0-9-]{36}$`).test(path)) return false;
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).list(`${userId}/${kind}`, { search: path.split('/').at(-1), limit: 10 });
    const item = data?.find(item => item.name === path.split('/').at(-1));
    if (error || !item || !MIME_TYPES.has(item.metadata?.mimetype) || !item.metadata?.size || item.metadata.size > 5 * 1024 * 1024 || (kind.startsWith('photo_') && item.metadata.mimetype === 'application/pdf')) return false;
  }
  return true;
};
const createUpload = (userId, kind) => supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(`${userId}/${kind}/${randomUUID()}`);
module.exports = { BUCKET, REQUIRED_DOCUMENTS, MIME_TYPES, validateDocuments, createUpload };
