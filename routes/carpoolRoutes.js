const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { fetchRideRowById } = require('../lib/repository');
const { sendError } = require('../lib/http');
const { pushToUsers } = require('../lib/push');
const { driverPhotoUrl } = require('../lib/driverPhoto');
const carpools = require('../lib/carpools');

// Carpools: families share one KidRide ride (see lib/carpools.js). Parents only.
// The ride itself is booked through POST /rides/request with `carpoolId`.
const router = express.Router();

const requireParent = (req, res, next) => (req.user.role === 'parent' ? next() : res.status(403).json({ message: 'Parent account required' }));
const fail = (status, message) => Object.assign(new Error(message), { status });
// Until the SQL is run every carpool request answers "not switched on yet" instead of a server error.
const report = (res, error, fallback) => (carpools.schemaMissing(error) ? res.status(503).json({ message: carpools.NOT_READY, code: 'carpools_unavailable' }) : sendError(res, error, fallback));
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'A parent';

// Codes are short so they can be read out; this stops them being guessed.
const codeLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Too many tries. Wait a few minutes, then check the code with the parent who sent it.',
  keyPrefix: 'carpool-code',
  keyGenerator: (req) => (req.user && req.user.id ? `user:${req.user.id}` : null)
});

/** A line in the inbox and a phone alert for these parents. Never fails the request that caused it. */
const tell = async (userIds, title, body) => {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  try {
    const { error } = await supabaseAdmin.from('notifications').insert(ids.map((user_id) => ({ user_id, kind: 'carpool', title: title.slice(0, 120), body: body.slice(0, 400) })));
    if (error) console.warn('Carpool notice not saved', error.message);
    await pushToUsers(ids, { title, body, data: { status: 'carpool' } });
  } catch (error) {
    console.warn('Carpool notice failed', error?.message || error);
  }
};

/** The rides of booked carpools. A carpool whose ride was cancelled is open again. */
const loadRides = async (rows) => {
  const rides = new Map();
  await Promise.all(rows.filter((row) => row.ride_id).map(async (row) => {
    const ride = await fetchRideRowById(row.ride_id);
    if (ride && ride.status !== 'cancelled') {
      rides.set(row.id, ride);
      return;
    }
    if (row.status !== 'booked') return;
    const { error } = await supabaseAdmin.from('carpools').update({ status: 'open', ride_id: null, updated_at: new Date().toISOString() }).eq('id', row.id).eq('status', 'booked');
    if (error) console.warn('Carpool not reopened', error.message);
    row.status = 'open';
    row.ride_id = null;
  }));
  return rides;
};

/** Carpool rows as this parent sees them. */
const present = async (user, rows) => {
  if (!rows.length) return [];
  const [members, rides] = await Promise.all([carpools.loadMembers(supabaseAdmin, rows.map((row) => row.id)), loadRides(rows)]);
  const { people, children } = await carpools.loadPeople(supabaseAdmin, rows, members);
  return Promise.all(rows.map(async (row) => {
    const own = members.filter((member) => member.carpool_id === row.id);
    const ride = rides.get(row.id) || null;
    // Families in the car see the driver's face once one has accepted.
    const inCar = own.some((member) => member.parent_id === user.id);
    let photoUrl = null;
    if (ride?.driver_id && inCar) {
      try { photoUrl = await driverPhotoUrl(ride.driver_id); } catch (error) { console.warn('Driver photo failed', error?.message || error); }
    }
    return carpools.formatCarpoolFor(user.id, row, own, people, children, ride, { photoUrl });
  }));
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const loadCarpool = async (id) => {
  if (!UUID.test(String(id))) throw fail(404, 'Carpool not found');
  const { data, error } = await supabaseAdmin.from('carpools').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw fail(404, 'Carpool not found');
  return data;
};

/** The carpool, its families and whether changes are still possible (not booked, not over). */
const loadForChange = async (id) => {
  const carpool = await loadCarpool(id);
  const [members, rides] = await Promise.all([carpools.loadMembers(supabaseAdmin, [carpool.id]), loadRides([carpool])]);
  const state = carpools.carpoolState(carpool, rides.get(carpool.id) || null);
  return { carpool, members, state };
};

const CLOSED = {
  booked: 'The ride for this carpool is already booked, so it can no longer be changed.',
  completed: 'This carpool has finished.',
  expired: 'This carpool\'s time has passed.',
  cancelled: 'This carpool was cancelled.'
};

/** Saves which children a family is sending, unless that needs more seats than the car has. */
const saveChildren = async (carpool, members, parentId, childIds) => {
  const others = carpools.seatsTaken(members.filter((member) => member.parent_id !== parentId));
  const left = carpool.seats - others;
  if (childIds.length > left) throw fail(409, left <= 0 ? 'This carpool is full.' : `Only ${left} ${left === 1 ? 'seat is' : 'seats are'} left in this carpool.`);
  const { error } = await supabaseAdmin.from('carpool_members')
    .upsert({ carpool_id: carpool.id, parent_id: parentId, child_ids: childIds }, { onConflict: 'carpool_id,parent_id' });
  if (error) throw error;
  // Two families can take the last seat at the same moment: whoever made it too many steps back.
  const after = await carpools.loadMembers(supabaseAdmin, [carpool.id]);
  if (carpools.seatsTaken(after) > carpool.seats) {
    const previous = members.find((member) => member.parent_id === parentId);
    if (previous) await supabaseAdmin.from('carpool_members').update({ child_ids: previous.child_ids }).eq('carpool_id', carpool.id).eq('parent_id', parentId);
    else await supabaseAdmin.from('carpool_members').delete().eq('carpool_id', carpool.id).eq('parent_id', parentId);
    throw fail(409, 'Another family just took the last seat. Check the carpool and try again.');
  }
};

const names = (ids, ownChildren) => {
  const list = ids.map((id) => (ownChildren || []).find((child) => child.id === id)?.name).filter(Boolean).map((name) => String(name).trim().split(/\s+/)[0]);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0] || '';
};

// Every carpool this parent set up or joined: coming up first, then recent ones.
router.get('/', protect, requireParent, async (req, res) => {
  try {
    const { data: mine, error } = await supabaseAdmin.from('carpool_members').select('carpool_id').eq('parent_id', req.user.id);
    if (error) throw error;
    const ids = (mine || []).map((row) => row.carpool_id);
    if (!ids.length) return res.json({ carpools: [] });
    const recent = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows, error: rowsError } = await supabaseAdmin.from('carpools').select('*').in('id', ids).neq('status', 'cancelled').gte('pickup_time', recent).order('pickup_time', { ascending: true }).limit(40);
    if (rowsError) throw rowsError;
    const list = await present(req.user, rows || []);
    const live = (item) => item.state === 'open' || item.state === 'booked';
    return res.json({ carpools: [...list.filter(live), ...list.filter((item) => !live(item)).reverse()] });
  } catch (error) {
    // Until the SQL is run the app shows carpools as not available yet.
    if (carpools.schemaMissing(error)) return res.json({ carpools: [], unavailable: true });
    return sendError(res, error, 'Unable to load carpools');
  }
});

router.post('/', protect, requireParent, async (req, res) => {
  const { carpool, error: invalid } = carpools.parseCarpool(req.body);
  if (invalid) return res.status(400).json({ message: invalid });
  const sending = carpools.parseChildIds(req.body.childIds === undefined ? [] : req.body.childIds, req.user.children, { allowNone: true });
  if (sending.error) return res.status(sending.status || 400).json({ message: sending.error });
  if (sending.childIds.length > carpool.seats) return res.status(400).json({ message: `This carpool takes ${carpool.seats} children; you chose ${sending.childIds.length}.` });
  try {
    const { count, error: countError } = await supabaseAdmin.from('carpools').select('id', { count: 'exact', head: true })
      .eq('organiser_id', req.user.id).eq('status', 'open').gte('pickup_time', new Date(Date.now() - carpools.LATE_BOOKING_MS).toISOString());
    if (countError) throw countError;
    if (count >= carpools.MAX_OPEN_PER_PARENT) return res.status(409).json({ message: `You can have up to ${carpools.MAX_OPEN_PER_PARENT} carpools waiting to be booked. Book or cancel one first.` });

    let created = null;
    // The code is random; on the rare clash with an existing one, another is drawn.
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const { data, error } = await supabaseAdmin.from('carpools').insert({ ...carpool, organiser_id: req.user.id, invite_code: carpools.generateCode() }).select('*').single();
      if (error && error.code !== '23505') throw error;
      created = data || null;
    }
    if (!created) throw new Error('No free invite code');
    const { error: memberError } = await supabaseAdmin.from('carpool_members').insert({ carpool_id: created.id, parent_id: req.user.id, child_ids: sending.childIds });
    if (memberError) {
      await supabaseAdmin.from('carpools').delete().eq('id', created.id);
      throw memberError;
    }
    const [view] = await present(req.user, [created]);
    return res.status(201).json({ carpool: view });
  } catch (error) {
    return report(res, error, 'Unable to set up this carpool');
  }
});

// What a carpool is, before joining it: shown from the invite code alone.
router.get('/code/:code', protect, requireParent, codeLimiter, async (req, res) => {
  const code = carpools.normalizeCode(req.params.code);
  if (!code) return res.status(400).json({ message: 'A carpool code has 6 letters and numbers.' });
  try {
    const { data, error } = await supabaseAdmin.from('carpools').select('*').eq('invite_code', code).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ message: 'No carpool has that code. Check it with the parent who sent it.' });
    const [view] = await present(req.user, [data]);
    if (view.state !== 'open' && !view.isMember) return res.status(409).json({ message: CLOSED[view.state] || 'This carpool is no longer open.' });
    return res.json({ carpool: view });
  } catch (error) {
    return report(res, error, 'Unable to look up that code');
  }
});

router.post('/join', protect, requireParent, codeLimiter, async (req, res) => {
  const code = carpools.normalizeCode(req.body.code);
  if (!code) return res.status(400).json({ message: 'A carpool code has 6 letters and numbers.' });
  const sending = carpools.parseChildIds(req.body.childIds, req.user.children);
  if (sending.error) return res.status(sending.status || 400).json({ message: sending.error });
  try {
    const { data: found, error } = await supabaseAdmin.from('carpools').select('id').eq('invite_code', code).maybeSingle();
    if (error) throw error;
    if (!found) return res.status(404).json({ message: 'No carpool has that code. Check it with the parent who sent it.' });
    const { carpool, members, state } = await loadForChange(found.id);
    if (state !== 'open') return res.status(409).json({ message: CLOSED[state] });
    const already = members.some((member) => member.parent_id === req.user.id);
    await saveChildren(carpool, members, req.user.id, sending.childIds);
    if (!already) {
      await tell([carpool.organiser_id], `${firstName(req.user.name)} joined ${carpool.name}`, `${names(sending.childIds, req.user.children) || 'Their child'} will ride. Book the ride once everyone is in.`);
    }
    const [view] = await present(req.user, [carpool]);
    return res.status(already ? 200 : 201).json({ carpool: view });
  } catch (error) {
    return report(res, error, 'Unable to join this carpool');
  }
});

router.get('/:id', protect, requireParent, async (req, res) => {
  try {
    const carpool = await loadCarpool(req.params.id);
    const [view] = await present(req.user, [carpool]);
    if (!view.isMember) return res.status(403).json({ message: 'Join this carpool with its code to see it.' });
    return res.json({ carpool: view });
  } catch (error) {
    return report(res, error, 'Unable to load this carpool');
  }
});

// A family changes which of its children are riding, until the ride is booked.
router.put('/:id/children', protect, requireParent, async (req, res) => {
  try {
    const { carpool, members, state } = await loadForChange(req.params.id);
    if (!members.some((member) => member.parent_id === req.user.id)) return res.status(403).json({ message: 'Join this carpool with its code first.' });
    if (state !== 'open') return res.status(409).json({ message: CLOSED[state] });
    const organiser = carpool.organiser_id === req.user.id;
    const sending = carpools.parseChildIds(req.body.childIds, req.user.children, { allowNone: organiser });
    if (sending.error) return res.status(sending.status || 400).json({ message: sending.error });
    await saveChildren(carpool, members, req.user.id, sending.childIds);
    const [view] = await present(req.user, [carpool]);
    return res.json({ carpool: view });
  } catch (error) {
    return report(res, error, 'Unable to change who is riding');
  }
});

// A family that joined steps out again, until the ride is booked.
router.delete('/:id/membership', protect, requireParent, async (req, res) => {
  try {
    const { carpool, members, state } = await loadForChange(req.params.id);
    if (!members.some((member) => member.parent_id === req.user.id)) return res.status(404).json({ message: 'You are not in this carpool.' });
    if (carpool.organiser_id === req.user.id) return res.status(409).json({ message: 'You set this carpool up. Cancel it instead of leaving.' });
    if (state === 'booked') return res.status(409).json({ message: `The ride is already booked. Ask ${firstName((await carpools.loadPeople(supabaseAdmin, [carpool], [])).people.get(carpool.organiser_id)?.name)} to cancel it if your child cannot come.` });
    const { error } = await supabaseAdmin.from('carpool_members').delete().eq('carpool_id', carpool.id).eq('parent_id', req.user.id);
    if (error) throw error;
    if (state === 'open') await tell([carpool.organiser_id], `${firstName(req.user.name)} left ${carpool.name}`, 'Their seats are free again.');
    return res.json({ ok: true });
  } catch (error) {
    return report(res, error, 'Unable to leave this carpool');
  }
});

// The organiser calls the carpool off. A booked ride is cancelled in Rides first (a fee can apply there).
router.delete('/:id', protect, requireParent, async (req, res) => {
  try {
    const { carpool, members, state } = await loadForChange(req.params.id);
    if (carpool.organiser_id !== req.user.id) return res.status(403).json({ message: 'Only the parent who set up this carpool can cancel it.' });
    if (state === 'booked') return res.status(409).json({ message: 'Cancel the booked ride first (Rides, then Upcoming). The carpool opens again and can then be cancelled.' });
    if (state === 'cancelled') return res.json({ ok: true });
    const { error } = await supabaseAdmin.from('carpools').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', carpool.id);
    if (error) throw error;
    if (state === 'open') {
      await tell(members.map((member) => member.parent_id).filter((id) => id !== req.user.id), `${carpool.name} was cancelled`, `${firstName(req.user.name)} cancelled this carpool. No ride was booked.`);
    }
    return res.json({ ok: true });
  } catch (error) {
    return report(res, error, 'Unable to cancel this carpool');
  }
});

module.exports = router;
