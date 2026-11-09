-- Driver verification: identity provider results on the profile, every unusual
-- event a driver triggers (driver_flags), and the checks they must complete
-- before taking new rides (driver_checks). Rules: lib/reverification.js.

alter table public.profiles add column if not exists identity_status text not null default 'none'
  check (identity_status in ('none', 'pending', 'processing', 'requires_input', 'verified'));
alter table public.profiles add column if not exists identity_session_id text;
alter table public.profiles add column if not exists identity_verified_at timestamptz;
alter table public.profiles add column if not exists identity_error jsonb;
alter table public.profiles add column if not exists last_spot_check_at timestamptz;
-- Last time the driver was Online (last_online_at is cleared when they go Offline).
alter table public.profiles add column if not exists last_active_at timestamptz;

create table if not exists public.driver_flags (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 40),
  ride_id uuid references public.rides (id) on delete set null,
  details jsonb,
  created_at timestamptz not null default timezone('utc', now())
);
create index if not exists driver_flags_driver_reason_idx on public.driver_flags (driver_id, reason, created_at desc);

create table if not exists public.driver_checks (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('identity', 'liveness', 'id_document', 'vehicle_photo', 'plate_photo', 'location_photo')),
  reason text not null check (char_length(reason) between 1 and 40),
  clears text not null default 'review' check (clears in ('submit', 'review', 'provider')),
  status text not null default 'pending' check (status in ('pending', 'submitted', 'passed', 'failed', 'cancelled')),
  ride_id uuid references public.rides (id) on delete set null,
  details jsonb,
  challenge jsonb,
  evidence jsonb,
  requested_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null,
  review_note text
);
create index if not exists driver_checks_driver_idx on public.driver_checks (driver_id, created_at desc);
create index if not exists driver_checks_open_idx on public.driver_checks (status, created_at desc) where status in ('pending', 'submitted', 'failed');

-- Only the API (service role) reads or writes these.
alter table public.driver_flags enable row level security;
alter table public.driver_checks enable row level security;
revoke all on public.driver_flags, public.driver_checks from anon, authenticated;
grant all on public.driver_flags, public.driver_checks to service_role;

-- New automatic ride alerts: drove past the drop-off, frequent stops, impossible GPS jump.
alter table public.ride_incidents drop constraint if exists ride_incidents_kind_check;
alter table public.ride_incidents add constraint ride_incidents_kind_check
  check (kind in ('sos', 'trip_code', 'off_route', 'stalled', 'overshoot', 'frequent_stops', 'gps_jump'));
alter table public.rides drop constraint if exists rides_safety_alert_check;
alter table public.rides add constraint rides_safety_alert_check
  check (safety_alert in ('sos', 'trip_code', 'off_route', 'stalled', 'overshoot', 'frequent_stops', 'gps_jump'));

-- Account deletion removes a driver's check photos with the rest of driver-verification/<id>/ (same bucket).
