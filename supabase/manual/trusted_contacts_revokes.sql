-- Run once in the Supabase SQL editor (the migration connector cannot run this).
-- Matches the other service-only tables: browsers never touch trusted_contacts
-- directly; all reads and writes go through the KidRide API.
revoke all on public.trusted_contacts from anon, authenticated;
grant all on public.trusted_contacts to service_role;
