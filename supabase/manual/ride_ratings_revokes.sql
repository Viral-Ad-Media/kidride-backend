-- Run once in the Supabase SQL editor (the migration connector cannot run this).
-- Matches the other service-only tables: browsers never touch ride_ratings
-- directly; all reads and writes go through the KidRide API.
revoke all on public.ride_ratings from anon, authenticated;
grant all on public.ride_ratings to service_role;
