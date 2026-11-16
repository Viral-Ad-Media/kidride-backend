// Second guardian. A parent (the family owner) invites one more adult by
// email. Once they accept, that guardian works on the owner's family: the
// same children, rides, repeating bookings, trusted contacts, tracking and
// ride alerts. Their own login, profile, password and notification settings
// stay their own. The owner can remove them at any time; they can leave.
//
// Until public.family_guardians exists (second_guardian.sql), every lookup
// falls back to "no family links" and the invite endpoints answer 503.

const MAX_GUARDIANS = 1;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205', 'PGRST204']);
const isMissingTable = (error) => !!error && (MISSING_TABLE_CODES.has(error.code) || /family_guardians/.test(error.message || '') && /does not exist|schema cache/.test(error.message || ''));

const normaliseEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const cleanText = (value, max) => {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : null;
};

// Validates an invite before it is saved. Returns { error } or { invite }.
const parseInvite = (body, owner) => {
  const email = normaliseEmail(body?.email);
  if (!EMAIL_PATTERN.test(email) || email.length > 254) return { error: 'Enter a valid email address.' };
  if (email === normaliseEmail(owner.email)) return { error: 'You cannot invite yourself.' };
  return { invite: { email, name: cleanText(body?.name, 80), relationship: cleanText(body?.relationship, 40) } };
};

// The family a signed-in user acts for: the owner's id for an active
// guardian, otherwise their own id. Never throws.
const resolveFamily = async (supabaseAdmin, user) => {
  const self = { familyId: user.id, familyRole: 'owner', familyOwnerId: user.id };
  if (!user || user.role !== 'parent') return self;
  try {
    const { data, error } = await supabaseAdmin.from('family_guardians')
      .select('owner_id').eq('guardian_id', user.id).eq('status', 'active').maybeSingle();
    if (error || !data?.owner_id) return self;
    return { familyId: data.owner_id, familyRole: 'guardian', familyOwnerId: data.owner_id };
  } catch {
    return self;
  }
};

// Active guardians of a family (profile rows), for ride alerts. Never throws.
const fetchGuardianProfiles = async (supabaseAdmin, ownerId, columns = 'id, name, email, notify_email') => {
  if (!ownerId) return [];
  try {
    const { data, error } = await supabaseAdmin.from('family_guardians')
      .select('guardian_id').eq('owner_id', ownerId).eq('status', 'active');
    const ids = (error ? [] : data || []).map((row) => row.guardian_id).filter(Boolean);
    if (!ids.length) return [];
    const { data: profiles } = await supabaseAdmin.from('profiles').select(columns).in('id', ids).eq('is_blocked', false);
    return profiles || [];
  } catch {
    return [];
  }
};

// What the Family section of the profile shows.
const formatLink = (row, profile) => ({
  id: row.id,
  status: row.status,
  email: profile?.email || row.invitee_email,
  name: profile?.name || row.invitee_name || null,
  relationship: row.relationship || null,
  invitedAt: row.created_at,
  acceptedAt: row.accepted_at || null
});

module.exports = { MAX_GUARDIANS, isMissingTable, normaliseEmail, parseInvite, resolveFamily, fetchGuardianProfiles, formatLink };
