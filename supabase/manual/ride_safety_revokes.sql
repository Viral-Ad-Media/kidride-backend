-- Run once in the Supabase SQL editor (the migration connector cannot run this).
-- Browsers never touch incidents or safety settings; the KidRide API does.
revoke all on public.ride_incidents from anon, authenticated;
revoke all on public.safety_settings from anon, authenticated;
grant all on public.ride_incidents to service_role;
grant all on public.safety_settings to service_role;
