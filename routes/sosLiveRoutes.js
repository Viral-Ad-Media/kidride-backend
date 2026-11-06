const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const { RIDE_SELECT } = require('../lib/repository');
const { hashToken, isTokenShaped, publicSosView } = require('../lib/sosShare');

// Public page behind an SOS live-location link (no sign-in: trusted contacts
// have no account). The token is the only key; unknown, expired and handled
// links all answer the same way so the endpoint does not reveal which exist.
const router = express.Router();

const limiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, keyPrefix: 'sos-live', message: 'Too many requests. Wait a minute and refresh.' });
const GONE = { active: false, message: 'This live location link is no longer active. The alert was handled or the link expired.' };

router.get('/:token', limiter, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!isTokenShaped(req.params.token)) return res.status(404).json(GONE);
  try {
    const { data: incident, error } = await supabaseAdmin.from('ride_incidents')
      .select('id, ride_id, kind, reporter_role, location, created_at, resolved_at, share_expires_at')
      .eq('share_token_hash', hashToken(req.params.token)).maybeSingle();
    if (error) throw error;
    if (!incident) return res.status(404).json(GONE);
    const { data: ride, error: rideError } = await supabaseAdmin.from('rides').select(RIDE_SELECT).eq('id', incident.ride_id).maybeSingle();
    if (rideError) throw rideError;
    const { data: child } = ride?.child_id ? await supabaseAdmin.from('children').select('name').eq('id', ride.child_id).maybeSingle() : { data: null };
    const view = publicSosView({ incident, ride, childName: child?.name });
    if (!view || !view.active) return res.status(404).json(GONE);
    return res.json(view);
  } catch (error) {
    console.warn('SOS live link failed', error?.message || error);
    return res.status(500).json({ message: 'Could not load the live location. Try again shortly. If anyone is in danger, call 911.' });
  }
});

module.exports = router;
