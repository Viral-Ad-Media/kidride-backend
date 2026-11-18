const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');
const promotions = require('../lib/promotions');

// Promotions (see lib/promotions.js).
//   admin:  /api/admin/promotions  create, change, switch on and off, see how much each was used
//   router: /api/promotions        what a parent is offered right now
// The discount itself is applied by the fare quotes and the booking in routes/rideRoutes.js.

const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ message: 'Admin required' }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Until the SQL is run every promotions request answers "not switched on yet" instead of a server error.
const report = (res, error, fallback) => (promotions.schemaMissing(error)
  ? res.status(503).json({ message: promotions.NOT_READY, code: 'promotions_unavailable' })
  : sendError(res, error, fallback));

// ---- Admin ----

const admin = express.Router();

/** Promotions as the admin page shows them: with how often each was used, what it saved parents, and its chosen parents. */
const present = async (rows) => {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [used, chosen] = await Promise.all([
    supabaseAdmin.from('promotion_redemptions').select('promotion_id, amount').in('promotion_id', ids).limit(10000),
    supabaseAdmin.from('promotion_users').select('promotion_id, parent_id').in('promotion_id', ids).limit(10000)
  ]);
  if (used.error) throw used.error;
  if (chosen.error) throw chosen.error;
  const parentIds = [...new Set((chosen.data || []).map((row) => row.parent_id))];
  const people = new Map();
  if (parentIds.length) {
    const { data, error } = await supabaseAdmin.from('profiles').select('id, name, email').in('id', parentIds);
    if (error) throw error;
    for (const profile of data || []) people.set(profile.id, profile);
  }
  return rows.map((row) => {
    const redemptions = (used.data || []).filter((item) => item.promotion_id === row.id);
    return promotions.formatPromotion(row, {
      uses: redemptions.length,
      saved: redemptions.reduce((sum, item) => sum + Number(item.amount || 0), 0),
      users: (chosen.data || []).filter((item) => item.promotion_id === row.id).map((item) => people.get(item.parent_id)).filter(Boolean)
        .map((profile) => ({ id: profile.id, name: profile.name, email: profile.email }))
    });
  });
};

const loadOne = async (id) => {
  if (!UUID.test(String(id))) return null;
  const { data, error } = await supabaseAdmin.from('promotions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
};

/** Replaces the chosen parents of a promotion. Only parent accounts count. */
const saveUsers = async (promotionId, userIds) => {
  const { error: clearError } = await supabaseAdmin.from('promotion_users').delete().eq('promotion_id', promotionId);
  if (clearError) throw clearError;
  if (!userIds.length) return;
  const { data, error } = await supabaseAdmin.from('profiles').select('id').in('id', userIds).eq('role', 'parent');
  if (error) throw error;
  const parents = (data || []).map((row) => row.id);
  if (!parents.length) throw Object.assign(new Error('None of the chosen accounts is a parent.'), { status: 400 });
  const { error: insertError } = await supabaseAdmin.from('promotion_users').insert(parents.map((parent_id) => ({ promotion_id: promotionId, parent_id })));
  if (insertError) throw insertError;
};

const CODE_TAKEN = 'Another promotion already uses that code. Choose a different one.';

admin.get('/', protect, requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('promotions').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    return res.json({ promotions: await present(data || []), limits: { minPercent: promotions.MIN_PERCENT, maxPercent: promotions.MAX_PERCENT } });
  } catch (error) {
    // Until the SQL is run the page says promotions are not switched on.
    if (promotions.schemaMissing(error)) return res.json({ promotions: [], unavailable: true, limits: { minPercent: promotions.MIN_PERCENT, maxPercent: promotions.MAX_PERCENT } });
    return sendError(res, error, 'Unable to load promotions');
  }
});

admin.post('/', protect, requireAdmin, async (req, res) => {
  const { promotion, userIds, error: invalid } = promotions.parsePromotion(req.body);
  if (invalid) return res.status(400).json({ message: invalid });
  try {
    const { data, error } = await supabaseAdmin.from('promotions').insert({ ...promotion, created_by: req.user.id }).select('*').single();
    if (error?.code === '23505') return res.status(409).json({ message: CODE_TAKEN });
    if (error) throw error;
    try {
      await saveUsers(data.id, userIds);
    } catch (userError) {
      await supabaseAdmin.from('promotions').delete().eq('id', data.id);
      throw userError;
    }
    const [view] = await present([data]);
    return res.status(201).json({ promotion: view });
  } catch (error) {
    return report(res, error, 'Unable to create this promotion');
  }
});

// Change a promotion. Sending only { active } switches it on or off.
admin.put('/:id', protect, requireAdmin, async (req, res) => {
  try {
    const existing = await loadOne(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Promotion not found' });
    const keys = Object.keys(req.body || {});
    if (keys.length === 1 && keys[0] === 'active') {
      if (typeof req.body.active !== 'boolean') return res.status(400).json({ message: 'active must be true or false' });
      const { data, error } = await supabaseAdmin.from('promotions').update({ active: req.body.active, updated_at: new Date().toISOString() }).eq('id', existing.id).select('*').single();
      if (error) throw error;
      const [view] = await present([data]);
      return res.json({ promotion: view });
    }
    const { promotion, userIds, error: invalid } = promotions.parsePromotion(req.body);
    if (invalid) return res.status(400).json({ message: invalid });
    const { data, error } = await supabaseAdmin.from('promotions').update({ ...promotion, updated_at: new Date().toISOString() }).eq('id', existing.id).select('*').single();
    if (error?.code === '23505') return res.status(409).json({ message: CODE_TAKEN });
    if (error) throw error;
    await saveUsers(data.id, userIds);
    const [view] = await present([data]);
    return res.json({ promotion: view });
  } catch (error) {
    return report(res, error, 'Unable to save this promotion');
  }
});

// A promotion nobody has used can be removed. One that was used is kept (its rides refer to it): switch it off instead.
admin.delete('/:id', protect, requireAdmin, async (req, res) => {
  try {
    const existing = await loadOne(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Promotion not found' });
    const { count, error: countError } = await supabaseAdmin.from('promotion_redemptions').select('id', { count: 'exact', head: true }).eq('promotion_id', existing.id);
    if (countError) throw countError;
    if (count > 0) return res.status(409).json({ message: 'This promotion has been used, so it is kept for the record. Switch it off instead.' });
    const { error } = await supabaseAdmin.from('promotions').delete().eq('id', existing.id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (error) {
    return report(res, error, 'Unable to remove this promotion');
  }
});

// ---- Parents ----

const router = express.Router();

// Seasonal offers open to this parent now (they apply on their own when booking). Codes are never listed.
router.get('/offers', protect, async (req, res) => {
  if (req.user.role !== 'parent') return res.json({ offers: [] });
  try {
    const { data, error } = await supabaseAdmin.from('promotions').select('*').eq('active', true).is('code', null).limit(100);
    if (error) throw error;
    const open = [];
    for (const offer of data || []) {
      if (!(await promotions.blockedBy(supabaseAdmin, offer, req.user.id))) open.push(offer);
    }
    open.sort((a, b) => Number(b.percent_off) - Number(a.percent_off));
    return res.json({ offers: open.map(promotions.publicPromotion) });
  } catch (error) {
    // Offers are an extra: with any problem the app simply shows none.
    if (!promotions.schemaMissing(error)) console.error('Offers lookup failed', error.message);
    return res.json({ offers: [] });
  }
});

module.exports = { router, admin };
