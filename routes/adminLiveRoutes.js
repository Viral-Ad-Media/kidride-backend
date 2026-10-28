const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendError } = require('../lib/http');

// Admin live map: online drivers with their latest position and whether they
// are on a ride, plus every ride in progress with its stops and driver.
const router = express.Router();

const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const IN_PROGRESS_STATUSES = ['requested', 'searching_driver', 'driver_assigned', 'driver_arrived_at_pickup', 'child_picked_up'];
const BUSY_STATUSES = ['driver_assigned', 'driver_arrived_at_pickup', 'child_picked_up'];

router.get('/', protect, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin required' });
  try {
    const since = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
    const [locations, rides] = await Promise.all([
      supabaseAdmin.from('driver_locations').select('driver_id, lat, lng, heading, updated_at').gte('updated_at', since),
      supabaseAdmin.from('rides')
        .select('id, status, driver_id, pickup_location, dropoff_location, pickup_coords, dropoff_coords, dispatch_state, driver_location, safety_alert, safety_alert_at, created_at')
        .in('status', IN_PROGRESS_STATUSES)
        .order('created_at', { ascending: false })
        .limit(200)
    ]);
    if (locations.error) throw locations.error;
    if (rides.error) throw rides.error;

    const driverIds = (locations.data || []).map((row) => row.driver_id);
    const { data: profiles, error: profileError } = driverIds.length
      ? await supabaseAdmin.from('profiles').select('id, name, phone, vehicle').in('id', driverIds).eq('role', 'driver').gte('last_online_at', since)
      : { data: [], error: null };
    if (profileError) throw profileError;
    const profileById = new Map((profiles || []).map((row) => [row.id, row]));
    const rideByDriver = new Map((rides.data || []).filter((ride) => ride.driver_id && BUSY_STATUSES.includes(ride.status)).map((ride) => [ride.driver_id, ride.id]));

    const drivers = (locations.data || [])
      .filter((row) => profileById.has(row.driver_id))
      .map((row) => {
        const profile = profileById.get(row.driver_id);
        const vehicle = profile.vehicle && typeof profile.vehicle === 'object' ? profile.vehicle : {};
        return {
          id: row.driver_id,
          name: profile.name,
          phone: profile.phone || null,
          vehicle: [vehicle.color, vehicle.make, vehicle.model].filter(Boolean).join(' ') || null,
          plate: vehicle.plate || null,
          lat: row.lat,
          lng: row.lng,
          heading: row.heading ?? null,
          updatedAt: row.updated_at,
          status: rideByDriver.has(row.driver_id) ? 'on_ride' : 'free',
          rideId: rideByDriver.get(row.driver_id) || null
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const nameById = new Map(drivers.map((driver) => [driver.id, driver.name]));
    const activeRides = (rides.data || []).map((ride) => ({
      id: ride.id,
      status: ride.status,
      dispatchState: ride.dispatch_state || 'open',
      pickup: ride.pickup_location,
      dropoff: ride.dropoff_location,
      pickupCoords: ride.pickup_coords || null,
      dropoffCoords: ride.dropoff_coords || null,
      driverId: ride.driver_id || null,
      driverName: ride.driver_id ? nameById.get(ride.driver_id) || null : null,
      // During a trip the ride's own GPS fix is the most recent driver position.
      driverLocation: ride.driver_location || null,
      safetyAlert: ride.safety_alert || null,
      safetyAlertAt: ride.safety_alert_at || null,
      createdAt: ride.created_at
    }));

    return res.json({
      generatedAt: new Date().toISOString(),
      counts: {
        online: drivers.length,
        onRide: drivers.filter((driver) => driver.status === 'on_ride').length,
        ridesInProgress: activeRides.filter((ride) => BUSY_STATUSES.includes(ride.status)).length,
        searching: activeRides.filter((ride) => !ride.driverId).length,
        alerts: activeRides.filter((ride) => ride.safetyAlert).length
      },
      drivers,
      rides: activeRides
    });
  } catch (error) {
    return sendError(res, error, 'Unable to load the live map');
  }
});

module.exports = router;
