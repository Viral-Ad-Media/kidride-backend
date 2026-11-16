const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const { OPEN_RIDE_STATUSES } = require('../lib/account');
const { MAX_GUARDIANS, isMissingTable, normaliseEmail, parseInvite, formatLink } = require('../lib/guardians');
const { sendEmail, FRONTEND_URL } = require('../lib/notifications');

// Second guardian: invite, accept or decline, remove, leave.
const router = express.Router();

const requireParent = (req, res, next) => (req.user.role === 'parent' ? next() : res.status(403).json({ message: 'Parent account required' }));
const inviteLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many invites. Please try again later.', keyPrefix: 'family', keyGenerator: (req) => req.user?.id });

const fail = (status, message) => Object.assign(new Error(message), { status });
const NOT_READY = 'Second guardians are not switched on yet. Please try again later.';
const check = (error) => {
  if (!error) return;
  if (isMissingTable(error)) throw fail(503, NOT_READY);
  throw error;
};
const firstName = (name) => (name || '').trim().split(/\s+/)[0] || 'A parent';

const note = async (userId, title, body, kind) => {
  const { error } = await supabaseAdmin.from('notifications').insert({ user_id: userId, kind, title: title.slice(0, 120), body: body.slice(0, 400) });
  if (error) console.warn('Family notification not saved', error.message);
};

const familyState = async (user) => {
  const email = normaliseEmail(user.email);
  const [owned, mine, invites] = await Promise.all([
    supabaseAdmin.from('family_guardians').select('*').eq('owner_id', user.id).order('created_at', { ascending: true }),
    supabaseAdmin.from('family_guardians').select('*').eq('guardian_id', user.id).eq('status', 'active').maybeSingle(),
    supabaseAdmin.from('family_guardians').select('*').eq('status', 'pending').eq('invitee_email', email)
  ]);
  for (const result of [owned, mine, invites]) check(result.error);
  const people = [...(owned.data || []).map((row) => row.guardian_id), mine.data?.owner_id, ...(invites.data || []).map((row) => row.owner_id)].filter(Boolean);
  const { data: profiles, error } = people.length ? await supabaseAdmin.from('profiles').select('id, name, email').in('id', people) : { data: [] };
  if (error) throw error;
  const byId = new Map((profiles || []).map((p) => [p.id, p]));
  const owner = mine.data ? byId.get(mine.data.owner_id) : null;
  return {
    available: true,
    role: mine.data ? 'guardian' : 'owner',
    maxGuardians: MAX_GUARDIANS,
    owner: owner ? { linkId: mine.data.id, name: owner.name, email: owner.email, since: mine.data.accepted_at } : null,
    guardians: mine.data ? [] : (owned.data || []).map((row) => formatLink(row, byId.get(row.guardian_id))),
    invites: (invites.data || []).filter((row) => row.owner_id !== user.id).map((row) => {
      const from = byId.get(row.owner_id);
      return { id: row.id, fromName: from?.name || 'A KidRide parent', fromEmail: from?.email || null, relationship: row.relationship || null, invitedAt: row.created_at };
    })
  };
};

router.get('/', protect, requireParent, async (req, res) => {
  try {
    return res.json(await familyState(req.user));
  } catch (error) {
    if (error.status === 503) return res.json({ available: false, role: 'owner', maxGuardians: MAX_GUARDIANS, owner: null, guardians: [], invites: [] });
    return sendError(res, error, 'Unable to load your family right now');
  }
});

// The owner invites a second guardian by email.
router.post('/guardians', protect, requireParent, inviteLimiter, async (req, res) => {
  try {
    if (req.user.familyRole === 'guardian') throw fail(403, 'Only the parent who owns the family account can invite a guardian.');
    const parsed = parseInvite(req.body, req.user);
    if (parsed.error) throw fail(400, parsed.error);
    const { email, name, relationship } = parsed.invite;

    const { data: existing, error: listError } = await supabaseAdmin.from('family_guardians').select('id, invitee_email').eq('owner_id', req.user.id);
    check(listError);
    if ((existing || []).some((row) => normaliseEmail(row.invitee_email) === email)) throw fail(409, 'You have already invited this person.');
    if ((existing || []).length >= MAX_GUARDIANS) throw fail(409, MAX_GUARDIANS === 1 ? 'You already have a second guardian. Remove them first to invite someone else.' : `You can have up to ${MAX_GUARDIANS} guardians.`);

    const { data: account } = await supabaseAdmin.from('profiles').select('id, role, name').eq('email', email).maybeSingle();
    if (account && account.role !== 'parent') throw fail(400, 'That email belongs to a driver or staff account. Ask them to use a parent account.');

    const { data: row, error } = await supabaseAdmin.from('family_guardians')
      .insert({ owner_id: req.user.id, invitee_email: email, invitee_name: name || account?.name || null, relationship })
      .select('*').single();
    if (error?.code === '23505') throw fail(409, 'You have already invited this person.');
    check(error);

    const from = firstName(req.user.name);
    const title = `${from} invited you to share KidRide`;
    const body = `${from} would like you to be a second guardian. You will see the children, book and follow rides, and get the same ride alerts. Open Profile, Family to accept.`;
    if (account) await note(account.id, title, body, 'guardian_invite');
    const emailed = await sendEmail(email, title, account ? body : `${body} Sign up with this email address first.`, `${FRONTEND_URL}/#/${account ? 'profile' : 'signup'}`);

    return res.status(201).json({ guardian: formatLink(row, null), emailed, hasAccount: !!account });
  } catch (error) {
    return sendError(res, error, 'Unable to send the invite right now');
  }
});

// The owner removes a guardian (or withdraws an invite). Access ends at once.
router.delete('/guardians/:id', protect, requireParent, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('family_guardians').delete()
      .eq('id', req.params.id).eq('owner_id', req.user.id).select('guardian_id, status');
    check(error);
    if (!data?.length) throw fail(404, 'Guardian not found');
    const removed = data[0];
    if (removed.status === 'active' && removed.guardian_id) {
      await note(removed.guardian_id, 'You are no longer a guardian', `${firstName(req.user.name)} removed you from their KidRide family. You no longer see their children or rides.`, 'guardian_removed');
    }
    return res.json(await familyState(req.user));
  } catch (error) {
    return sendError(res, error, 'Unable to remove the guardian right now');
  }
});

const findInvite = async (req) => {
  const { data, error } = await supabaseAdmin.from('family_guardians').select('*').eq('id', req.params.id).eq('status', 'pending').maybeSingle();
  check(error);
  if (!data || normaliseEmail(data.invitee_email) !== normaliseEmail(req.user.email)) throw fail(404, 'Invite not found');
  return data;
};

router.post('/invites/:id/accept', protect, requireParent, async (req, res) => {
  try {
    const invite = await findInvite(req);
    if (req.user.familyRole === 'guardian') throw fail(409, 'You are already a guardian in another family. Leave it first.');
    const { data: ownGuardians, error: ownError } = await supabaseAdmin.from('family_guardians').select('id').eq('owner_id', req.user.id).eq('status', 'active');
    check(ownError);
    if (ownGuardians?.length) throw fail(409, 'Your own family already has a second guardian. Remove them before joining another family.');
    const { data: openRides, error: ridesError } = await supabaseAdmin.from('rides').select('id').eq('parent_id', req.user.id).in('status', OPEN_RIDE_STATUSES).limit(1);
    if (ridesError) throw ridesError;
    if (openRides?.length) throw fail(409, 'Finish or cancel your own booked rides before joining another family.');
    const { data: series } = await supabaseAdmin.from('ride_series').select('id').eq('parent_id', req.user.id).eq('status', 'active').limit(1);
    if (series?.length) throw fail(409, 'Stop your own repeating bookings before joining another family.');

    const { data: updated, error } = await supabaseAdmin.from('family_guardians')
      .update({ guardian_id: req.user.id, status: 'active', accepted_at: new Date().toISOString() })
      .eq('id', invite.id).eq('status', 'pending').select('id');
    if (error?.code === '23505') throw fail(409, 'You are already a guardian in another family. Leave it first.');
    check(error);
    if (!updated?.length) throw fail(404, 'Invite not found');
    // Pending invites this person sent for their own family no longer apply.
    await supabaseAdmin.from('family_guardians').delete().eq('owner_id', req.user.id).eq('status', 'pending');

    await note(invite.owner_id, `${firstName(req.user.name)} accepted your invite`, `${req.user.name || 'Your second guardian'} can now see your children, book and follow rides, and gets the same ride alerts.`, 'guardian_joined');
    return res.json({ joined: true });
  } catch (error) {
    return sendError(res, error, 'Unable to accept the invite right now');
  }
});

router.post('/invites/:id/decline', protect, requireParent, async (req, res) => {
  try {
    const invite = await findInvite(req);
    const { error } = await supabaseAdmin.from('family_guardians').delete().eq('id', invite.id).eq('status', 'pending');
    check(error);
    return res.json(await familyState(req.user));
  } catch (error) {
    return sendError(res, error, 'Unable to decline the invite right now');
  }
});

// A guardian leaves the family they joined.
router.post('/leave', protect, requireParent, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('family_guardians').delete().eq('guardian_id', req.user.id).eq('status', 'active').select('owner_id');
    check(error);
    if (!data?.length) throw fail(404, 'You are not a guardian in another family');
    await note(data[0].owner_id, `${firstName(req.user.name)} left your family`, `${req.user.name || 'Your second guardian'} no longer sees your children or rides.`, 'guardian_left');
    return res.json({ left: true });
  } catch (error) {
    return sendError(res, error, 'Unable to leave the family right now');
  }
});

module.exports = router;
