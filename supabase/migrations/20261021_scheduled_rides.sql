-- Book for later.
-- A scheduled ride is stored like any other ride (pickup_time in UTC) with
-- is_scheduled = true. It is held back from drivers until 30 minutes before
-- pickup; the API then releases it (dispatch_released_at) into the normal
-- nearest-driver dispatch. Rides with no driver 5 minutes before pickup are
-- shown to admins as "needs attention" (worked out by the API, not stored).
--
-- One-active-ride guards: a parent may have one ride for now plus any number
-- of scheduled rides; a driver's accepted scheduled ride does not block other
-- trips until they start it (arrive at pickup). The new indexes below replace
-- rides_one_active_parent and rides_one_active_driver, which are removed by
-- supabase/manual/scheduled_rides_old_guards.sql after this migration.

alter table public.rides add column if not exists is_scheduled boolean not null default false;
alter table public.rides add column if not exists dispatch_released_at timestamptz;

-- Scheduled rides are always booked with a pickup time.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rides_scheduled_has_pickup_time') then
    alter table public.rides add constraint rides_scheduled_has_pickup_time
      check (not is_scheduled or pickup_time is not null);
  end if;
end $$;

create unique index if not exists rides_one_now_ride_per_parent
  on public.rides (parent_id)
  where status not in ('completed', 'cancelled') and not is_scheduled;

create unique index if not exists rides_one_started_ride_per_driver
  on public.rides (driver_id)
  where driver_id is not null
    and status not in ('completed', 'cancelled')
    and not (is_scheduled and status = 'driver_assigned');

-- Finding rides that are due for release, and upcoming lists.
create index if not exists rides_scheduled_pickup_idx
  on public.rides (pickup_time)
  where is_scheduled and status not in ('completed', 'cancelled');
