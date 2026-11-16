const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');
const { schemaMissing } = require('../lib/ratingRules');
const { MAX_PLACES, parsePlace, sameLabel, formatPlace, sortPlaces } = require('../lib/savedPlaces');

// A parent's saved places (Home, School, Piano lesson), picked when booking.
const router = express.Router();

const COLUMNS = 'id, label, address, lat, lng, kind, created_at, updated_at';
const NOT_READY = 'Saved places are not switched on yet. Please try again later.';

const requireParent = (req, res, next) => (req.user.role === 'parent' ? next() : res.status(403).json({ message: 'Parent account required' }));

const listPlaces = async (parentId) => {
  const { data, error } = await supabaseAdmin.from('saved_places').select(COLUMNS).eq('parent_id', parentId);
  if (error) throw error;
  return sortPlaces((data || []).map(formatPlace));
};

router.get('/', protect, requireParent, async (req, res) => {
  try {
    return res.json({ places: await listPlaces(req.user.id) });
  } catch (error) {
    // Until the SQL is run the booking flow simply shows no saved places.
    if (schemaMissing(error)) return res.json({ places: [], unavailable: true });
    return sendError(res, error, 'Unable to load saved places');
  }
});

router.post('/', protect, requireParent, async (req, res) => {
  const { place, error: invalid } = parsePlace(req.body);
  if (invalid) return res.status(400).json({ message: invalid });
  try {
    const existing = await listPlaces(req.user.id);
    if (existing.length >= MAX_PLACES) return res.status(409).json({ message: `You can save up to ${MAX_PLACES} places. Remove one to add another.` });
    if (existing.some((item) => sameLabel(item.label, place.label))) return res.status(409).json({ message: `You already have a place called ${place.label}. Choose another name or edit that one.` });
    const { data, error } = await supabaseAdmin.from('saved_places').insert({ parent_id: req.user.id, ...place }).select(COLUMNS).single();
    if (error) throw error;
    return res.status(201).json({ place: formatPlace(data), places: await listPlaces(req.user.id) });
  } catch (error) {
    if (schemaMissing(error)) return res.status(503).json({ message: NOT_READY });
    return sendError(res, error, 'Unable to save this place');
  }
});

router.put('/:id', protect, requireParent, async (req, res) => {
  const { place, error: invalid } = parsePlace(req.body);
  if (invalid) return res.status(400).json({ message: invalid });
  try {
    const existing = await listPlaces(req.user.id);
    if (!existing.some((item) => item.id === req.params.id)) return res.status(404).json({ message: 'Place not found' });
    if (existing.some((item) => item.id !== req.params.id && sameLabel(item.label, place.label))) return res.status(409).json({ message: `You already have a place called ${place.label}.` });
    const { data, error } = await supabaseAdmin.from('saved_places')
      .update({ ...place, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('parent_id', req.user.id)
      .select(COLUMNS).single();
    if (error) throw error;
    return res.json({ place: formatPlace(data), places: await listPlaces(req.user.id) });
  } catch (error) {
    if (schemaMissing(error)) return res.status(503).json({ message: NOT_READY });
    return sendError(res, error, 'Unable to update this place');
  }
});

router.delete('/:id', protect, requireParent, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('saved_places').delete().eq('id', req.params.id).eq('parent_id', req.user.id).select('id');
    if (error) throw error;
    if (!data?.length) return res.status(404).json({ message: 'Place not found' });
    return res.json({ places: await listPlaces(req.user.id) });
  } catch (error) {
    if (schemaMissing(error)) return res.status(503).json({ message: NOT_READY });
    return sendError(res, error, 'Unable to remove this place');
  }
});

module.exports = router;
