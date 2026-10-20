-- Driver presence: the app sends a heartbeat every 60 s while a driver is
-- Online and clears it when they go Offline. A driver counts as online when
-- last_online_at is within the last 2 minutes.

alter table public.profiles add column if not exists last_online_at timestamptz;

create index if not exists profiles_driver_presence_idx on public.profiles (role, last_online_at desc);
