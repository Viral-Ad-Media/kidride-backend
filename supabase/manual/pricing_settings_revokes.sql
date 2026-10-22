-- Run once in the Supabase SQL editor (the migration connector cannot run this).
-- Browsers never touch pricing_settings; the admin edits it through the KidRide API.
revoke all on public.pricing_settings from anon, authenticated;
grant all on public.pricing_settings to service_role;
