-- Apply after 2026-10-04_security_services.sql. Safe to re-run.

-- Session revocation: KidRide JWTs carry this version; bumping it invalidates
-- every token issued before (logout everywhere / compromised device).
alter table public.profiles add column if not exists token_version integer not null default 0;

-- Driver earnings summary computed in the database, so totals are not capped
-- by the 100-row list limit.
create or replace function public.driver_ride_summary(p_driver uuid)
returns table (completed_count bigint, total_earnings numeric)
language sql stable security definer set search_path = public as $$
  select count(*), coalesce(sum(price), 0)
  from public.rides
  where driver_id = p_driver and status = 'completed';
$$;
revoke all on function public.driver_ride_summary(uuid) from public, anon, authenticated;
grant execute on function public.driver_ride_summary(uuid) to service_role;

-- Last GPS fix must not outlive the trip.
update public.rides set driver_location = null
where status in ('completed', 'cancelled') and driver_location is not null;

-- Rides must reference a real child. Abort (never silently delete history) if
-- existing rows would violate the constraint; resolve those rows first.
do $$
declare
  bad_rows integer;
begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public' and table_name = 'rides' and constraint_name = 'rides_child_id_fkey'
  ) then
    return;
  end if;

  select count(*) into bad_rows from public.rides r
  where r.child_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or not exists (select 1 from public.children c where c.id::text = lower(r.child_id));
  if bad_rows > 0 then
    raise exception 'rides_child_id_fkey: % ride(s) reference a missing or malformed child_id; review them before re-running', bad_rows;
  end if;

  alter table public.rides alter column child_id type uuid using child_id::uuid;
  -- NO ACTION (not RESTRICT) so deleting a profile can still cascade to both
  -- its children and its rides in one statement.
  alter table public.rides add constraint rides_child_id_fkey
    foreign key (child_id) references public.children (id);
end $$;

create index if not exists rides_child_id_idx on public.rides (child_id);
