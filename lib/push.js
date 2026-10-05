const { supabaseAdmin } = require('../config/supabase');
// Await delivery attempts so serverless runtimes do not discard unawaited work.
const notifyRide = async (ride) => {
  try {
    const ids = [ride.parent_id, ride.driver_id].filter(Boolean);
    const { data, error } = await supabaseAdmin.from('push_tokens').select('token').in('user_id', ids);
    if (error || !data?.length) return;
    const messages = data.map(({ token }) => ({ to: token, sound: 'default', title: 'KidRide trip update', body: `Trip status: ${ride.status.replace(/_/g, ' ')}`, data: { rideId: ride.id, status: ride.status } }));
    for (let offset = 0; offset < messages.length; offset += 100) {
      const batch = messages.slice(offset, offset + 100);
      const response = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) }, body: JSON.stringify(batch), signal: AbortSignal.timeout(5000) });
      if (!response.ok) { console.warn('Push delivery unavailable', response.status); continue; }
      const result = await response.json();
      for (const [i, ticket] of (result.data || []).entries()) {
        if (ticket.details?.error === 'DeviceNotRegistered') await supabaseAdmin.from('push_tokens').delete().eq('token', batch[i].to);
        else if (ticket.status === 'ok' && ticket.id) await supabaseAdmin.from('push_receipts').insert({ ticket_id: ticket.id, token: batch[i].to });
      }
    }
  } catch { console.warn('Push delivery failed; ride update saved'); }
};
module.exports = { notifyRide };
