const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { fetchRideRowById } = require('../lib/repository');
const { sendError } = require('../lib/http');
const { schemaMissing } = require('../lib/ratingRules');
const { pushToUsers } = require('../lib/push');
const { sendWebPush } = require('../lib/webPush');
const { COLUMNS, CLOSED_MESSAGE, NO_DRIVER_MESSAGE, parseMessage, chatRole, chatOpen, formatMessage, pushWords, listMessages, sweepIfDue, transcriptForSafety } = require('../lib/rideChat');

// Chat between the parent and the driver of a ride. Mounted under /rides beside
// the ride routes: /rides/:id/messages. It works from the moment a driver accepts
// until the trip ends; after that neither of them can read it, and KidRide keeps
// a compressed copy for safety (lib/rideChat.js).
const router = express.Router();

const NOT_READY = 'Messages are not switched on yet. Please call instead.';

const sendLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'You are sending messages very quickly. Wait a moment, or call instead.',
  keyPrefix: 'ride-chat',
  keyGenerator: (req) => (req.user && req.user.id ? `user:${req.user.id}` : null)
});

// The ride and which side of its chat the caller is on. Admins may read (a safety review), never write.
const loadChat = async (req, res, { write = false } = {}) => {
  const ride = await fetchRideRowById(req.params.id);
  if (!ride) {
    res.status(404).json({ message: 'Ride not found' });
    return null;
  }
  const role = chatRole(req.user, ride);
  if (!role && (write || req.user.role !== 'admin')) {
    res.status(403).json({ message: 'Not authorized to access this ride' });
    return null;
  }
  return { ride, role };
};

router.get('/:id/messages', protect, async (req, res) => {
  try {
    const chat = await loadChat(req, res);
    if (!chat) return undefined;
    // Chats that should have been closed already are tidied away now and then.
    await sweepIfDue(supabaseAdmin);
    if (!chat.role) {
      // KidRide's safety team, looking into an incident or a complaint: the whole record of the ride.
      console.warn('Chat record read by admin', { admin: req.user.id, ride: chat.ride.id });
      return res.json({ messages: await transcriptForSafety(supabaseAdmin, chat.ride), canSend: false, unread: 0, closed: !chatOpen(chat.ride), safetyRecord: true });
    }
    // The trip has ended (or no driver has accepted yet): there is no chat to show.
    if (!chatOpen(chat.ride)) return res.json({ messages: [], canSend: false, unread: 0, closed: true });
    const messages = await listMessages(supabaseAdmin, chat.ride, req.user.id);
    return res.json({
      messages,
      canSend: true,
      unread: messages.filter((message) => !message.mine && !message.readAt).length,
      closed: false
    });
  } catch (error) {
    // Until the SQL is run the apps simply show an empty chat that cannot send.
    if (schemaMissing(error)) return res.json({ messages: [], canSend: false, unread: 0, unavailable: true });
    return sendError(res, error, 'Unable to load messages');
  }
});

router.post('/:id/messages', protect, sendLimiter, async (req, res) => {
  const { text, error: invalid } = parseMessage(req.body);
  if (invalid) return res.status(400).json({ message: invalid });
  try {
    const chat = await loadChat(req, res, { write: true });
    if (!chat) return undefined;
    const { ride, role } = chat;
    if (!ride.driver_id) return res.status(409).json({ message: NO_DRIVER_MESSAGE, code: 'chat_closed' });
    if (!chatOpen(ride)) return res.status(409).json({ message: CLOSED_MESSAGE, code: 'chat_closed' });

    const { data, error } = await supabaseAdmin.from('ride_messages')
      .insert({ ride_id: ride.id, driver_id: ride.driver_id, sender_id: req.user.id, sender_role: role, body: text })
      .select(COLUMNS).single();
    if (error) throw error;

    // Tell the other person's phone and browser. A failed alert never fails the message: it is saved and shows in the chat.
    const recipient = role === 'parent' ? ride.driver_id : ride.parent_id;
    const words = pushWords({ from: role, senderName: req.user.name, text });
    await Promise.all([
      pushToUsers([recipient], { ...words, data: { rideId: ride.id, status: 'chat_message' } }),
      sendWebPush([{ userId: recipient, ...words, url: `/#/tracking/${ride.id}`, kind: 'chat_message', rideId: ride.id }])
        .catch((pushError) => console.warn('Chat browser alert failed', pushError?.message || pushError))
    ]);
    return res.status(201).json({ message: formatMessage(data, req.user.id) });
  } catch (error) {
    if (schemaMissing(error)) return res.status(503).json({ message: NOT_READY });
    return sendError(res, error, 'Unable to send this message');
  }
});

// The chat was opened: everything the other person sent counts as read.
router.put('/:id/messages/read', protect, async (req, res) => {
  try {
    const chat = await loadChat(req, res, { write: true });
    if (!chat) return undefined;
    const { ride } = chat;
    if (!ride.driver_id) return res.json({ ok: true });
    const { error } = await supabaseAdmin.from('ride_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('ride_id', ride.id).eq('driver_id', ride.driver_id).neq('sender_id', req.user.id).is('read_at', null);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (error) {
    if (schemaMissing(error)) return res.json({ ok: true });
    return sendError(res, error, 'Unable to update messages');
  }
});

module.exports = router;
