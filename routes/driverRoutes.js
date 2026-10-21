const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');
const { fetchRatingSummaries } = require('../lib/ratings');
const { RIDE_SELECT, fetchRideRows, formatRide } = require('../lib/repository');
const { isApprovedDriver, redactOffer, validateCoordinates } = require('../lib/security');
const dispatch = require('../lib/dispatch');
const scheduling = require('../lib/scheduling');

const router = express.Router();

const NEARBY_RADIUS_METERS = 5000;
const NEARBY_LIMIT = 20;

// Waiting rides around an idle driver, nearest first, for the map on their
// dashboard. Rides being offered to another driver, and rides booked for
// later that are not open to drivers yet, are left out (they could not accept
// them); rides this driver declined are included and flagged.
router.get('/nearby-rides', protect, async (req, res) => {
  try {
    if (!isApprovedDriver(req.user)) return res.status(403).json({ message: 'Only approved drivers can see nearby rides' });

    let origin = null;
    const latitude = Number(req.query.lat);
    const longitude = Number(req.query.lng);
    if (req.query.lat !== undefined && req.query.lng !== undefined) {
      if (!validateCoordinates({ latitude, longitude })) return res.status(400).json({ message: 'lat and lng must be valid coordinates' });
      origin = { lat: latitude, lng: longitude };
    } else {
      const { data, error } = await supabaseAdmin.from('driver_locations').select('lat, lng').eq('driver_id', req.user.id).maybeSingle();
      if (error) throw error;
      if (data) origin = { lat: data.lat, lng: data.lng };
    }
    if (!origin) return res.json({ origin: null, radiusMeters: NEARBY_RADIUS_METERS, rides: [] });

    const [rides, declines, liveOffers] = await Promise.all([
      fetchRideRows(
        supabaseAdmin.from('rides').select(RIDE_SELECT)
          .in('status', dispatch.SEARCHING_STATUSES).is('driver_id', null)
          .order('created_at', { ascending: false }).limit(100)
      ),
      supabaseAdmin.from('ride_declines').select('ride_id').eq('driver_id', req.user.id),
      dispatch.fetchLiveOffers(req.user.id)
    ]);
    if (declines.error) throw declines.error;
    const declined = new Set((declines.data || []).map((row) => row.ride_id));

    const nearby = rides
      .filter((ride) => ride.pickup_coords && !scheduling.isHeld(ride) && (ride.dispatch_state !== 'targeted' || liveOffers.has(ride.id)))
      .map((ride) => ({ ride, distance: dispatch.distanceMeters(origin, ride.pickup_coords) }))
      .filter(({ distance }) => distance <= NEARBY_RADIUS_METERS)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, NEARBY_LIMIT)
      .map(({ ride, distance }) => ({
        ...redactOffer(formatRide(ride)),
        distanceMeters: Math.round(distance),
        declined: declined.has(ride.id),
        offerExpiresAt: liveOffers.get(ride.id) || null
      }));

    return res.json({ origin, radiusMeters: NEARBY_RADIUS_METERS, rides: nearby });
  } catch (error) {
    return sendError(res, error, 'Unable to load nearby rides');
  }
});

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
