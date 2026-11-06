-- KidRide security lockdown (run once in the Supabase SQL Editor).
-- The web app never talks to Supabase tables directly: every read and write goes
-- through the backend with the service-role key. But Supabase's default grants
-- still let any signed-in Supabase user (anyone with the public anon key and their
-- own password) read rows through the REST API. Example: an assigned driver could
-- read rides.trip_code and skip the trip-code check. This removes all table,
-- sequence and function access for the anon and authenticated roles, now and for
-- tables created later. The backend (service_role) is not affected.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- The backend still needs these.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Driver documents stay private (no public URL, 5 MB, jpeg/png/pdf only).
update storage.buckets
set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg','image/png','application/pdf']
where id = 'driver-verification';

-- Check: this should return no rows.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated');
