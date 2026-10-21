-- Run once in the Supabase SQL editor, AFTER migrations/20261021_scheduled_rides.sql
-- (which creates the replacement indexes rides_one_now_ride_per_parent and
-- rides_one_started_ride_per_driver).
-- The old guards allowed only one unfinished ride per parent / per driver,
-- which would block booking a ride for later.
drop index if exists public.rides_one_active_parent;
drop index if exists public.rides_one_active_driver;
