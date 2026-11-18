const { supabaseAdmin } = require('../config/supabase');

// Phone-app (Expo) push notifications. Delivery is awaited so serverless
// runtimes do not discard unawaited work, and it never throws: a push that
// cannot be sent must not fail the ride update or message that caused it.

const expoHeaders = () => ({ 'Content-Type': 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) });

/** Sends one notification to every phone registered to these accounts. */
const pushToUsers = async (userIds, { title, body, data: payload = {} }) => {
  try {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return;
    const { data, error } = await supabaseAdmin.from('push_tokens').select('token').in('user_id', ids);
    if (error || !data?.length) return;
    const messages = data.map(({ token }) => ({ to: token, sound: 'default', title, body, data: payload }));
    for (let offset = 0; offset < messages.length; offset += 100) {
      const batch = messages.slice(offset, offset + 100);
      const response = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: expoHeaders(), body: JSON.stringify(batch), signal: AbortSignal.timeout(5000) });
      if (!response.ok) { console.warn('Push delivery unavailable', response.status); continue; }
      const result = await response.json();
      for (const [i, ticket] of (result.data || []).entries()) {
        if (ticket.details?.error === 'DeviceNotRegistered') await supabaseAdmin.from('push_tokens').delete().eq('token', batch[i].to);
        else if (ticket.status === 'ok' && ticket.id) await supabaseAdmin.from('push_receipts').insert({ ticket_id: ticket.id, token: batch[i].to });
      }
    }
  } catch { console.warn('Push delivery failed; the update itself was saved'); }
};

/** A ride changed status: tell its parent and driver, and the other families when it is a carpool's ride. */
const notifyRide = (ride, alsoTell = []) => pushToUsers([ride.parent_id, ride.driver_id, ...alsoTell], {
  title: 'KidRide trip update',
  body: `Trip status: ${ride.status.replace(/_/g, ' ')}`,
  data: { rideId: ride.id, status: ride.status }
});

module.exports = { notifyRide, pushToUsers };
