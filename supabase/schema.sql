create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text not null,
  role text not null default 'parent' check (role in ('parent', 'driver', 'admin')),
  phone text,
  photo_url text,
  is_verified_driver boolean not null default false,
  driver_application_status text not null default 'none'
    check (driver_application_status in ('none', 'pending', 'approved', 'rejected')),
  vehicle jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists profiles_email_key on public.profiles (lower(email));

create table if not exists public.children (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  age integer not null check (age > 0),
  notes text,
  photo_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists children_parent_id_idx on public.children (parent_id, created_at desc);

create table if not exists public.rides (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles (id) on delete cascade,
  child_id text not null,
  driver_id uuid references public.profiles (id) on delete set null,
  pickup_location text not null,
  dropoff_location text not null,
  pickup_time timestamptz,
  status text not null default 'requested'
    check (status in (
      'requested',
      'searching_driver',
      'driver_assigned',
      'driver_arrived_at_pickup',
      'child_picked_up',
      'completed',
      'cancelled'
    )),
  price numeric(10, 2) not null check (price >= 0),
  trip_code text,
  safe_word text,
  service_type text not null default 'pickup_only'
    check (service_type in (
      'pickup_only',
      'dropoff_only',
      'pickup_and_dropoff',
      'stay_with_child_and_dropoff'
    )),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists rides_parent_id_idx on public.rides (parent_id, created_at desc);
create index if not exists rides_driver_id_idx on public.rides (driver_id, created_at desc);
create index if not exists rides_status_idx on public.rides (status, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

drop trigger if exists set_children_updated_at on public.children;
create trigger set_children_updated_at
before update on public.children
for each row
execute function public.set_updated_at();

drop trigger if exists set_rides_updated_at on public.rides;
create trigger set_rides_updated_at
before update on public.rides
for each row
execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.children enable row level security;
alter table public.rides enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "Parents can read their children" on public.children;
create policy "Parents can read their children"
on public.children
for select
to authenticated
using (auth.uid() = parent_id);

drop policy if exists "Parents can create their children" on public.children;
create policy "Parents can create their children"
on public.children
for insert
to authenticated
with check (auth.uid() = parent_id);

drop policy if exists "Parents can update their children" on public.children;
create policy "Parents can update their children"
on public.children
for update
to authenticated
using (auth.uid() = parent_id)
with check (auth.uid() = parent_id);

drop policy if exists "Participants can read rides" on public.rides;
create policy "Participants can read rides"
on public.rides
for select
to authenticated
using (auth.uid() = parent_id or auth.uid() = driver_id);

drop policy if exists "Parents can request rides" on public.rides;
create policy "Parents can request rides"
on public.rides
for insert
to authenticated
with check (auth.uid() = parent_id);

drop policy if exists "Participants can update rides" on public.rides;
create policy "Participants can update rides"
on public.rides
for update
to authenticated
using (auth.uid() = parent_id or auth.uid() = driver_id)
with check (auth.uid() = parent_id or auth.uid() = driver_id);
