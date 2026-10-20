const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { fetchUserById } = require('../lib/repository');
const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');
const { fetchRatingSummaries } = require('../lib/ratings');

// Admin-only user management: lists of drivers and parents, block/unblock,
// and withdrawing a driver's approval.
const router = express.Router();

const MAX_PAGE_SIZE = 100;
const MAX_REASON_LENGTH = 500;
// A driver is online while their heartbeat (every 60 s) is at most this old.
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ message: 'Admin required' }));

const cleanReason = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_REASON_LENGTH) : '');

const tally = (rows, key) => {
  const counts = new Map();
  for (const row of rows || []) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
  return counts;
};

router.get('/', protect, requireAdmin, async (req, res) => {
  const role = req.query.role;
  if (!['driver', 'parent'].includes(role)) return res.status(400).json({ message: 'role must be driver or parent' });
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 25));
  // Commas and parentheses would break the PostgREST or() filter.
  const search = typeof req.query.search === 'string' ? req.query.search.replace(/[,()%]/g, ' ').trim().slice(0, 100) : '';

  try {
    let query = supabaseAdmin
      .from('profiles')
      .select('id, name, email, phone, vehicle, is_verified_driver, driver_application_status, is_blocked, blocked_reason, blocked_at, created_at, last_online_at', { count: 'exact' })
      .eq('role', role)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    const { data: profiles, error, count } = await query;
    if (error) throw error;
    const ids = (profiles || []).map((profile) => profile.id);

    let extras = () => ({});
    let onlineCount;
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
    if (role === 'driver') {
      const { count: online, error: onlineError } = await supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'driver').gte('last_online_at', onlineSince);
      if (onlineError) throw onlineError;
      onlineCount = online || 0;
    }
    if (ids.length && role === 'driver') {
      const [rides, applications, ratings] = await Promise.all([
        supabaseAdmin.from('rides').select('driver_id').in('driver_id', ids).eq('status', 'completed'),
        supabaseAdmin.from('driver_applications').select('driver_id, submitted_at, reviewed_at, review_note').in('driver_id', ids),
        fetchRatingSummaries(ids)
      ]);
      if (rides.error) throw rides.error;
      if (applications.error) throw applications.error;
      const completed = tally(rides.data, 'driver_id');
      const applicationById = new Map((applications.data || []).map((row) => [row.driver_id, row]));
      extras = (profile) => {
        const application = applicationById.get(profile.id);
        return {
          vehicle: profile.vehicle && typeof profile.vehicle === 'object' ? profile.vehicle : {},
          isVerifiedDriver: !!profile.is_verified_driver,
          driverApplicationStatus: profile.driver_application_status || 'none',
          submittedAt: application?.submitted_at || null,
          reviewedAt: application?.reviewed_at || null,
          reviewNote: application?.review_note || null,
          completedRides: completed.get(profile.id) || 0,
          isOnline: !!profile.last_online_at && profile.last_online_at >= onlineSince,
          lastOnlineAt: profile.last_online_at || null,
          rating: ratings.get(profile.id)
        };
      };
    } else if (ids.length) {
      const [rides, children] = await Promise.all([
        supabaseAdmin.from('rides').select('parent_id').in('parent_id', ids),
        supabaseAdmin.from('children').select('parent_id').in('parent_id', ids)
      ]);
      if (rides.error) throw rides.error;
      if (children.error) throw children.error;
      const rideCounts = tally(rides.data, 'parent_id');
      const childCounts = tally(children.data, 'parent_id');
      extras = (profile) => ({ rides: rideCounts.get(profile.id) || 0, children: childCounts.get(profile.id) || 0 });
    }

    return res.json({
      page,
      pageSize,
      total: count || 0,
      ...(onlineCount === undefined ? {} : { onlineCount }),
      users: (profiles || []).map((profile) => ({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        phone: profile.phone || null,
        joinedAt: profile.created_at,
        isBlocked: !!profile.is_blocked,
        blockedReason: profile.blocked_reason || null,
        blockedAt: profile.blocked_at || null,
        ...extras(profile)
      }))
    });
  } catch (error) {
    return sendError(res, error, 'Unable to load users');
  }
});

const loadManagedUser = async (req, res) => {
  const user = await fetchUserById(req.params.id);
  if (!user || !['driver', 'parent'].includes(user.role)) {
    res.status(404).json({ message: 'Driver or parent not found' });
    return null;
  }
  return user;
};

router.put('/:id/block', protect, requireAdmin, async (req, res) => {
  const reason = cleanReason(req.body.reason);
  if (!reason) return res.status(400).json({ message: 'A reason is required to block an account' });
  try {
    const user = await loadManagedUser(req, res);
    if (!user) return undefined;
    // Bumping token_version signs the account out everywhere immediately.
    const { error } = await supabaseAdmin.from('profiles').update({
      is_blocked: true, blocked_reason: reason, blocked_at: new Date().toISOString(),
      token_version: user.tokenVersion + 1, updated_at: new Date().toISOString()
    }).eq('id', user.id);
    if (error) throw error;
    return res.json({ id: user.id, isBlocked: true, blockedReason: reason });
  } catch (error) {
    return sendError(res, error, 'Unable to block account');
  }
});

router.put('/:id/unblock', protect, requireAdmin, async (req, res) => {
  try {
    const user = await loadManagedUser(req, res);
    if (!user) return undefined;
    const { error } = await supabaseAdmin.from('profiles').update({
      is_blocked: false, blocked_reason: null, blocked_at: null, updated_at: new Date().toISOString()
    }).eq('id', user.id);
    if (error) throw error;
    return res.json({ id: user.id, isBlocked: false });
  } catch (error) {
    return sendError(res, error, 'Unable to unblock account');
  }
});

router.put('/driver-applications/:id/revoke', protect, requireAdmin, async (req, res) => {
  const reason = cleanReason(req.body.reason);
  if (!reason) return res.status(400).json({ message: 'A reason is required to revoke approval' });
  try {
    const user = await loadManagedUser(req, res);
    if (!user) return undefined;
    if (user.role !== 'driver' || user.driverApplicationStatus !== 'approved') return res.status(409).json({ message: 'Only an approved driver can have approval revoked' });
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from('profiles').update({
      is_verified_driver: false, driver_application_status: 'rejected', updated_at: now
    }).eq('id', user.id).eq('driver_application_status', 'approved');
    if (error) throw error;
    const { error: noteError } = await supabaseAdmin.from('driver_applications').update({ review_note: reason, reviewed_at: now }).eq('driver_id', user.id);
    if (noteError) throw noteError;
    return res.json({ id: user.id, driverApplicationStatus: 'rejected', reviewNote: reason });
  } catch (error) {
    return sendError(res, error, 'Unable to revoke approval');
  }
});

module.exports = router;
