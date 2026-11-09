const webpush = require('web-push');
const { supabaseAdmin } = require('../config/supabase');

// Browser push (Web Push with VAPID keys): works in Chrome, Edge, Firefox and
// Safari, including iPhone once KidRide is added to the Home Screen. Keys live
// in VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY; without them push is simply off and
// the in-app inbox and email keep working. Nothing here ever throws.

const publicKey = () => process.env.VAPID_PUBLIC_KEY || '';
let configured = null;
const ready = () => {
  if (configured !== null) return configured;
  try {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return (configured = false);
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@kidride.app', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    configured = true;
  } catch (error) {
    console.warn('Web push keys are not valid', error?.message || error);
    configured = false;
  }
  return configured;
};

// Safety alerts ask the browser to keep them on screen until tapped.
const URGENT_KINDS = new Set(['sos', 'trip_code', 'off_route', 'stalled', 'rating_low']);

/**
 * messages: [{ userId, title, body, url, kind, rideId }]. A browser gets alerts while
 * it is subscribed; switching alerts off in the app unsubscribes it. Dead
 * subscriptions are removed.
 */
const sendWebPush = async (messages) => {
  if (!ready() || !messages?.length) return 0;
  let sent = 0;
  try {
    const userIds = [...new Set(messages.map((m) => m.userId))];
    const { data: subs, error } = await supabaseAdmin.from('web_push_subscriptions').select('id, user_id, endpoint, p256dh, auth').in('user_id', userIds);
    if (error || !subs?.length) return 0;
    const dead = [];
    const used = [];
    await Promise.all(messages.flatMap((message) => subs.filter((sub) => sub.user_id === message.userId).map(async (sub) => {
      const payload = JSON.stringify({
        title: message.title, body: message.body, url: message.url || '/#/notifications', kind: message.kind || 'general',
        rideId: message.rideId || null, tag: message.rideId ? `ride-${message.rideId}` : undefined, urgent: URGENT_KINDS.has(message.kind)
      });
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 60 * 60, urgency: URGENT_KINDS.has(message.kind) ? 'high' : 'normal', timeout: 5000 });
        sent += 1;
        used.push(sub.id);
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) dead.push(sub.id);
        else console.warn('Web push not delivered', error?.statusCode || error?.message || error);
      }
    })));
    if (dead.length) await supabaseAdmin.from('web_push_subscriptions').delete().in('id', dead);
    if (used.length) await supabaseAdmin.from('web_push_subscriptions').update({ last_used_at: new Date().toISOString() }).in('id', [...new Set(used)]);
  } catch (error) {
    console.warn('Web push failed', error?.message || error);
  }
  return sent;
};

const validSubscription = (sub) => !!sub && typeof sub.endpoint === 'string' && /^https:\/\/[^\s]{5,990}$/.test(sub.endpoint)
  && typeof sub.keys?.p256dh === 'string' && /^[A-Za-z0-9_-]{10,200}={0,2}$/.test(sub.keys.p256dh)
  && typeof sub.keys?.auth === 'string' && /^[A-Za-z0-9_-]{8,100}={0,2}$/.test(sub.keys.auth);

module.exports = { publicKey, pushReady: ready, sendWebPush, validSubscription, URGENT_KINDS };
