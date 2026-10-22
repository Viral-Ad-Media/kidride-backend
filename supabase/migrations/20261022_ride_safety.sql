-- Ride safety: the driver must enter the parent's trip code before the child
-- gets in, SOS and automatic alerts are recorded as incidents on the ride, and
-- a driver can record a no-show after waiting at the pickup.

alter table public.rides add column if not exists arrived_at timestamptz;
alter table public.rides add column if not exists trip_code_attempts smallint not null default 0 check (trip_code_attempts >= 0);
alter table public.rides add column if not exists trip_code_verified_at timestamptz;
-- The most serious open incident on the ride, so lists can flag it without a join.
alter table public.rides add column if not exists safety_alert text check (safety_alert in ('sos', 'trip_code', 'off_route', 'stalled'));
alter table public.rides add column if not exists safety_alert_at timestamptz;
-- Route watch state for off-route and stalled checks (see lib/safety.js).
alter table public.rides add column if not exists monitor jsonb;
alter table public.rides add column if not exists cancel_reason text check (cancel_reason in ('no_show'));

create index if not exists rides_safety_alert_idx on public.rides (safety_alert_at desc) where safety_alert is not null;

create table if not exists public.ride_incidents (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides (id) on delete cascade,
  kind text not null check (kind in ('sos', 'trip_code', 'off_route', 'stalled')),
  reported_by uuid references public.profiles (id) on delete set null,
  reporter_role text check (reporter_role in ('parent', 'driver', 'admin', 'system')),
  location jsonb,
  details jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null
);
create index if not exists ride_incidents_ride_idx on public.ride_incidents (ride_id, created_at desc);
create index if not exists ride_incidents_open_idx on public.ride_incidents (created_at desc) where resolved_at is null;
-- Only the API (service role) reads or writes incidents.
alter table public.ride_incidents enable row level security;
grant all on public.ride_incidents to service_role;

-- Alert thresholds the admin edits; same single-row model as pricing_settings.
create table if not exists public.safety_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now())
);
alter table public.safety_settings enable row level security;
grant all on public.safety_settings to service_role;
