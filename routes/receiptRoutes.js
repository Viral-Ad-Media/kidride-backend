const router = require('express').Router();
const { timingSafeEqual } = require('node:crypto');
const { supabaseAdmin } = require('../config/supabase');
router.get('/', async (req, res) => {
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  const actual = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return res.status(401).json({ message: 'Not authorized' });
  try {
    const { data, error } = await supabaseAdmin.from('push_receipts').select('*').lt('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString()).limit(100);
    if (error) throw error;
    if (!data?.length) return res.json({ checked: 0 });
    const response = await fetch('https://exp.host/--/api/v2/push/getReceipts', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) }, body: JSON.stringify({ ids: data.map(x => x.ticket_id) }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Receipt provider unavailable');
    const result = await response.json();
    for (const item of data) {
      const receipt = result.data?.[item.ticket_id];
      if (!receipt && Date.now() - Date.parse(item.created_at) < 24 * 60 * 60 * 1000) continue;
      if (receipt?.details?.error === 'DeviceNotRegistered') await supabaseAdmin.from('push_tokens').delete().eq('token', item.token);
      await supabaseAdmin.from('push_receipts').delete().eq('ticket_id', item.ticket_id);
    }
    return res.json({ checked: data.length });
  } catch { return res.status(503).json({ message: 'Receipt processing unavailable' }); }
});
module.exports = router;
