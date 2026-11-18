-- Carpools: families who know each other share one KidRide ride. A parent sets
-- up the trip (name, pickup, drop-off, time, seats) and gets an invite code;
-- other parents join with the code and choose which of their children ride.
-- The organiser then books one ride for everyone, driven by a verified KidRide
-- driver like any other ride. All children meet at the one pickup point.
--
-- Nothing in the existing tables changes: a booked carpool points at its ride.

create table if not exists public.carpools (
  id uuid primary key default gen_random_uuid(),
  organiser_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 2 and 60),
  pickup_location text not null check (char_length(pickup_location) between 3 and 300),
  pickup_coords jsonb not null,
  dropoff_location text not null check (char_length(dropoff_location) between 3 and 300),
  dropoff_coords jsonb not null,
  pickup_time timestamptz not null,
  -- Children the car takes in all, across the families (a ride carries up to 4).
  seats smallint not null default 4 check (seats between 2 and 4),
  -- Six letters and digits without the look-alikes 0/O and 1/I.
  invite_code text not null check (invite_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  status text not null default 'open' check (status in ('open', 'booked', 'cancelled')),
  ride_id uuid references public.rides (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists carpools_invite_code_idx on public.carpools (invite_code);
create index if not exists carpools_organiser_idx on public.carpools (organiser_id, pickup_time);
-- A ride belongs to at most one carpool; ride events look the carpool up by it.
create unique index if not exists carpools_ride_idx on public.carpools (ride_id) where ride_id is not null;

-- One row per family in a carpool (the organiser included) with the children they are sending.
create table if not exists public.carpool_members (
  id uuid primary key default gen_random_uuid(),
  carpool_id uuid not null references public.carpools (id) on delete cascade,
  parent_id uuid not null references public.profiles (id) on delete cascade,
  child_ids uuid[] not null default '{}' check (cardinality(child_ids) <= 4),
  joined_at timestamptz not null default timezone('utc', now()),
  unique (carpool_id, parent_id)
);

create index if not exists carpool_members_parent_idx on public.carpool_members (parent_id);

-- Same model as the other tables: apps never touch them directly; all reads
-- and writes go through the KidRide API (service role).
alter table public.carpools enable row level security;
alter table public.carpool_members enable row level security;
revoke all on public.carpools from anon, authenticated;
revoke all on public.carpool_members from anon, authenticated;
grant all on public.carpools to service_role;
grant all on public.carpool_members to service_role;

notify pgrst, 'reload schema';
