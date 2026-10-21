const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');

// The signed-in user's notifications: list with the unread count, mark one
// or all as read. Rows are written by lib/notifications.js.

const router = express.Router();
const MAX_LIMIT = 50;

const format = (row) => ({
  id: row.id,
  rideId: row.ride_id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  readAt: row.read_at,
  createdAt: row.created_at
});

router.get('/', protect, async (req, res) => {
  try {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 20));
    const [{ data, error }, { count, error: countError }] = await Promise.all([
      supabaseAdmin.from('notifications').select('id, ride_id, kind, title, body, read_at, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(limit),
      supabaseAdmin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).is('read_at', null)
    ]);
    if (error) throw error;
    if (countError) throw countError;
    return res.json({ notifications: (data || []).map(format), unreadCount: count || 0 });
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/read-all', protect, async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', req.user.id).is('read_at', null);
    if (error) throw error;
    return res.json({ unreadCount: 0 });
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/:id/read', protect, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('notifications').update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('user_id', req.user.id).is('read_at', null).select('id').maybeSingle();
    if (error) throw error;
    return res.json({ updated: !!data });
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
