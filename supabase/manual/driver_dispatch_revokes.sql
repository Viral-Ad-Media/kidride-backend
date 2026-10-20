-- Run once in the Supabase SQL editor (the migration connector cannot run this).
-- Browsers never touch these tables directly; all access goes through the KidRide API.
revoke all on public.driver_locations from anon, authenticated;
revoke all on public.ride_offers from anon, authenticated;
grant all on public.driver_locations to service_role;
grant all on public.ride_offers to service_role;
