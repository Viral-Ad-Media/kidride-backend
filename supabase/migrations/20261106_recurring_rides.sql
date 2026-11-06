-- Recurring school-week rides. A parent books one series (children, route,
-- service, weekdays, local pickup time, date range); the API creates the
-- individual scheduled rides a week ahead, each priced on its own. A ride
-- created from a series carries series_id + series_date, and the unique pair
-- stops the same day from being created twice (or re-created after the parent
-- cancels that one day).
-- Run AFTER multi_child_rides.sql.

create table if not exists public.ride_series (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles(id) on delete cascade,
  child_ids uuid[] not null check (cardinality(child_ids) between 1 and 4),
  pickup_location text not null,
  dropoff_location text not null,
  pickup_coords jsonb,
  dropoff_coords jsonb,
  service_type text not null default 'pickup_only',
  stay_minutes integer not null default 0 check (stay_minutes between 0 and 480),
  weekdays smallint[] not null check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),
  pickup_local_time text not null check (pickup_local_time ~ '^([01][0-9]|2[0-3]):[0-5][05]$'),
  time_zone text not null,
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  skipped_dates date[] not null default '{}',
  route_miles numeric not null default 0,
  route_minutes integer not null default 0,
  distance_source text not null default 'none',
  status text not null default 'active' check (status in ('active', 'cancelled', 'ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ride_series_parent_idx on public.ride_series (parent_id, status);

alter table public.rides add column if not exists series_id uuid references public.ride_series(id) on delete set null;
alter table public.rides add column if not exists series_date date;
create unique index if not exists rides_series_day_uidx on public.rides (series_id, series_date);
create index if not exists rides_series_idx on public.rides (series_id) where series_id is not null;

-- Only the API (service role) touches series.
alter table public.ride_series enable row level security;
revoke all on table public.ride_series from anon, authenticated;
grant all on table public.ride_series to service_role;

notify pgrst, 'reload schema';
