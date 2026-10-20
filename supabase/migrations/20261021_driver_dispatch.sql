-- Nearest-driver dispatch.
-- driver_locations: the latest position of each online driver (sent about every
-- 10 s while Online), with its H3 cell (resolution 8) for neighbourhood lookups.
-- ride_offers: a new ride is offered to the nearest drivers one at a time
-- (20 s each); if nobody near accepts, the ride opens to every driver
-- (rides.dispatch_state = 'open'), which is also the default for older rides.

create table if not exists public.driver_locations (
  driver_id uuid primary key references public.profiles (id),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  heading double precision check (heading is null or heading between 0 and 360),
  h3_index text not null,
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists driver_locations_h3_idx on public.driver_locations (h3_index, updated_at desc);

create table if not exists public.ride_offers (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides (id),
  driver_id uuid not null references public.profiles (id),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (ride_id, driver_id)
);

create index if not exists ride_offers_driver_idx on public.ride_offers (driver_id, status, expires_at);
create index if not exists ride_offers_ride_idx on public.ride_offers (ride_id, created_at);

alter table public.rides add column if not exists dispatch_state text not null default 'open' check (dispatch_state in ('targeted', 'open'));

-- Same model as the other service-only tables: all access goes through the API.
alter table public.driver_locations enable row level security;
alter table public.ride_offers enable row level security;
grant all on public.driver_locations to service_role;
grant all on public.ride_offers to service_role;
