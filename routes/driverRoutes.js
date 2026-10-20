const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');
const { fetchRatingSummaries } = require('../lib/ratings');

const router = express.Router();

// Average rating for any driver; the written reviews are only for that driver and admins.
router.get('/:id/rating-summary', protect, async (req, res) => {
  try {
    const summary = (await fetchRatingSummaries([req.params.id])).get(req.params.id);
    const canSeeReviews = req.user.role === 'admin' || req.user.id === req.params.id;
    let reviews = [];
    if (canSeeReviews) {
      const { data, error } = await supabaseAdmin
        .from('ride_ratings')
        .select('stars, comment, created_at')
        .eq('driver_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      reviews = (data || []).map((row) => ({ stars: row.stars, comment: row.comment || null, createdAt: row.created_at }));
    }
    return res.json({ driverId: req.params.id, ...summary, reviews });
  } catch (error) {
    return sendError(res, error, 'Unable to load ratings');
  }
});

module.exports = router;
