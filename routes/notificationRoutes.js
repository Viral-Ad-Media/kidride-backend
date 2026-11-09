const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');
const { publicKey, pushReady, sendWebPush, validSubscription } = require('../lib/webPush');

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

// --- Browser push alerts -------------------------------------------------

// The public VAPID key the browser needs to subscribe. enabled=false means the
// server has no keys yet, so the app hides the push switch.
router.get('/push/config', protect, (req, res) => res.json({ enabled: pushReady(), publicKey: pushReady() ? publicKey() : null }));

router.post('/push/subscribe', protect, async (req, res) => {
  const sub = req.body?.subscription;
  if (!validSubscription(sub)) return res.status(400).json({ message: 'Invalid push subscription' });
  try {
    const { error } = await supabaseAdmin.from('web_push_subscriptions').upsert({
      user_id: req.user.id, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300) || null
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    return res.json({ subscribed: true });
  } catch (error) {
    return sendError(res, error, 'Push alerts are unavailable');
  }
});

router.delete('/push/subscribe', protect, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ message: 'Endpoint required' });
  try {
    const { error } = await supabaseAdmin.from('web_push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', req.user.id);
    if (error) throw error;
    return res.json({ subscribed: false });
  } catch (error) {
    return sendError(res, error, 'Push alerts are unavailable');
  }
});

// Sends a test alert to the signed-in user's browsers.
router.post('/push/test', protect, async (req, res) => {
  const sent = await sendWebPush([{ userId: req.user.id, title: 'KidRide alerts are on', body: 'You will get ride updates here, even when KidRide is closed.', url: '/#/notifications', kind: 'test' }]);
  return res.json({ sent });
});

module.exports = router;
