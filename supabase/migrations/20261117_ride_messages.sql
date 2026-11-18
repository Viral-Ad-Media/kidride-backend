-- Chat between the parent and the driver of a ride, from the moment a driver
-- accepts until the trip ends ("Where are you?", "I'm outside"). One row per
-- message. read_at is set when the other person opens the chat.
--
-- driver_id is the driver the conversation is with. A ride can go back to
-- searching (its driver's account was closed) and be taken by another driver;
-- the new driver must not see what was said to the first one.

create table if not exists public.ride_messages (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides (id) on delete cascade,
  driver_id uuid not null references public.profiles (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  sender_role text not null check (sender_role in ('parent', 'driver')),
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default timezone('utc', now()),
  read_at timestamptz
);

-- The table was first created without driver_id (same day, before any message was sent).
alter table public.ride_messages add column if not exists driver_id uuid references public.profiles (id) on delete cascade;
alter table public.ride_messages alter column driver_id set not null;

create index if not exists ride_messages_ride_idx on public.ride_messages (ride_id, created_at);
-- Unread messages for one reader of one ride (the badge on the Message button).
create index if not exists ride_messages_unread_idx on public.ride_messages (ride_id, sender_id) where read_at is null;

-- Same model as the other tables: apps never touch it directly; all reads and
-- writes go through the KidRide API (service role).
alter table public.ride_messages enable row level security;
revoke all on public.ride_messages from anon, authenticated;
grant all on public.ride_messages to service_role;
