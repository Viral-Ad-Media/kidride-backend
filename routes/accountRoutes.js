const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { supabaseAdmin, supabaseAuth } = require('../config/supabase');
const { sendError } = require('../lib/http');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const { BUCKET, REQUIRED_DOCUMENTS } = require('../lib/verification');
const { OPEN_RIDE_STATUSES, deletedEmail, anonymisedProfile, anonymisedChild, blockingRide, accountError } = require('../lib/account');

const router = express.Router();

// Exports and deletions are rare; a tight per-account limit stops abuse.
const accountLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many account requests. Please try again later.',
  keyPrefix: 'account',
  keyGenerator: (req) => req.user?.id
});

const rows = async (query) => {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

// Everything KidRide holds about the signed-in user, as one JSON download.
router.get('/export', protect, accountLimiter, async (req, res) => {
  try {
    const id = req.user.id;
    const rideColumn = req.user.role === 'driver' ? 'driver_id' : 'parent_id';
    const [profile, children, rides, trustedContacts, notifications, ratings, incidents] = await Promise.all([
      rows(supabaseAdmin.from('profiles').select('*').eq('id', id)),
      rows(supabaseAdmin.from('children').select('id, name, age, notes, created_at, archived_at').eq('parent_id', id)),
      rows(supabaseAdmin.from('rides').select('*').eq(rideColumn, id).order('created_at', { ascending: false })),
      rows(supabaseAdmin.from('trusted_contacts').select('name, phone, relationship, created_at').eq('parent_id', id)),
      rows(supabaseAdmin.from('notifications').select('*').eq('user_id', id).order('created_at', { ascending: false }).limit(1000)),
      rows(supabaseAdmin.from('ride_ratings').select('*').or(`parent_id.eq.${id},driver_id.eq.${id}`)),
      rows(supabaseAdmin.from('ride_incidents').select('*').eq('reported_by', id))
    ]);
    // Internal security fields are not personal data and are left out.
    const { token_version: _tv, ...profileData } = profile[0] || {};
    // Drivers do not see the parent's private trip code or safe word.
    const rideData = rides.map(({ trip_code: tripCode, safe_word: safeWord, ...ride }) => (
      req.user.role === 'driver' ? ride : { ...ride, trip_code: tripCode, safe_word: safeWord }
    ));
    res.setHeader('Content-Disposition', `attachment; filename="kidride-data-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.json({
      exportedAt: new Date().toISOString(),
      account: profileData,
      children,
      rides: rideData,
      trustedContacts,
      notifications,
      ratings,
      safetyReports: incidents
    });
  } catch (error) {
    return sendError(res, error, 'Unable to prepare your data right now');
  }
});

// Permanently delete the signed-in account. The password is asked again so a
// borrowed, unlocked phone cannot delete someone's account.
router.delete('/', protect, accountLimiter, async (req, res) => {
  try {
    const user = req.user;
    if (user.role === 'admin') throw accountError(403, 'Admin accounts are removed by another admin.');
    if (typeof req.body.password !== 'string' || !req.body.password) throw accountError(400, 'Enter your password to confirm.');

    const { data: check, error: passwordError } = await supabaseAuth.auth.signInWithPassword({ email: user.email, password: req.body.password });
    if (passwordError || check?.user?.id !== user.id) throw accountError(401, 'That password is not right.');

    const rideColumn = user.role === 'driver' ? 'driver_id' : 'parent_id';
    const openRides = await rows(supabaseAdmin.from('rides').select('id, status, is_scheduled').eq(rideColumn, user.id).in('status', OPEN_RIDE_STATUSES));
    if (blockingRide(openRides)) throw accountError(409, 'You have a ride in progress. Finish or cancel it before deleting your account.');

    const now = new Date();
    // Repeating bookings stop first, so no new rides are created for the account.
    if (user.role === 'parent') {
      const { error } = await supabaseAdmin.from('ride_series').update({ status: 'cancelled', updated_at: now.toISOString() }).eq('parent_id', user.id).eq('status', 'active');
      if (error && error.code !== '42P01') throw error;
    }
    // Unstarted scheduled rides: a parent's are cancelled, a driver's go back to dispatch.
    const scheduled = openRides.map((ride) => ride.id);
    if (scheduled.length) {
      const change = user.role === 'driver'
        ? { driver_id: null, status: 'searching_driver', dispatch_state: 'open', updated_at: now.toISOString() }
        : { status: 'cancelled', updated_at: now.toISOString() };
      const { error } = await supabaseAdmin.from('rides').update(change).in('id', scheduled);
      if (error) throw error;
    }

    // Personal data with no lasting purpose is removed outright.
    for (const [table, column] of [['trusted_contacts', 'parent_id'], ['push_tokens', 'user_id'], ['notifications', 'user_id'], ['driver_locations', 'driver_id'], ['ride_offers', 'driver_id']]) {
      const { error } = await supabaseAdmin.from(table).delete().eq(column, user.id);
      if (error && error.code !== '42P01') throw error;
    }

    if (user.role === 'parent') {
      const { error } = await supabaseAdmin.from('children').update(anonymisedChild(now)).eq('parent_id', user.id);
      if (error) throw error;
    }

    if (user.role === 'driver') {
      // Licence, insurance and vehicle photos are deleted; the approval decision stays on the profile.
      const paths = [];
      for (const kind of REQUIRED_DOCUMENTS) {
        const { data } = await supabaseAdmin.storage.from(BUCKET).list(`${user.id}/${kind}`, { limit: 100 });
        for (const item of data || []) paths.push(`${user.id}/${kind}/${item.name}`);
      }
      // Verification check photos (face checks, car, plate, location).
      const { data: checkFolders } = await supabaseAdmin.storage.from(BUCKET).list(`${user.id}/checks`, { limit: 1000 });
      for (const folder of checkFolders || []) {
        const { data } = await supabaseAdmin.storage.from(BUCKET).list(`${user.id}/checks/${folder.name}`, { limit: 100 });
        for (const item of data || []) paths.push(`${user.id}/checks/${folder.name}/${item.name}`);
      }
      if (paths.length) await supabaseAdmin.storage.from(BUCKET).remove(paths);
      await supabaseAdmin.from('driver_checks').update({ evidence: null, challenge: null, details: null }).eq('driver_id', user.id);
      await supabaseAdmin.from('profiles').update({ identity_session_id: null, identity_error: null }).eq('id', user.id);
      const { error } = await supabaseAdmin.from('driver_applications').delete().eq('driver_id', user.id);
      if (error) throw error;
    }

    const { error: profileError } = await supabaseAdmin.from('profiles')
      .update({ ...anonymisedProfile(user.id, now), token_version: (user.tokenVersion || 0) + 1 })
      .eq('id', user.id);
    if (profileError) throw profileError;

    // Close the login: new email (frees the old one for a fresh sign-up), metadata wiped, banned.
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      email: deletedEmail(user.id),
      email_confirm: true,
      password: require('crypto').randomBytes(32).toString('hex'),
      user_metadata: {},
      ban_duration: '876000h'
    });
    if (authError) console.error('Account deleted but the login could not be closed', user.id, authError.message);

    return res.json({ deleted: true });
  } catch (error) {
    return sendError(res, error, 'Unable to delete your account right now');
  }
});

module.exports = router;
