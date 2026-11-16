-- Saved places: a parent names an address once (Home, School, Piano lesson) and
-- picks it as pickup or drop-off when booking. Up to 20 per parent (enforced by
-- the API). Coordinates are kept so rides are priced by distance.

create table if not exists public.saved_places (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 40),
  address text not null check (char_length(address) between 3 and 300),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  kind text not null default 'other' check (kind in ('home', 'school', 'activity', 'other')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists saved_places_parent_label_idx on public.saved_places (parent_id, lower(label));

-- Same model as the other tables: browsers never touch it directly; all reads
-- and writes go through the KidRide API (service role).
alter table public.saved_places enable row level security;
revoke all on public.saved_places from anon, authenticated;
grant all on public.saved_places to service_role;
