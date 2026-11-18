-- The safety copy of a ride's chat. While a trip is under way its messages live
-- in ride_messages, where the parent and the driver read them. When the trip
-- ends the chat closes for both of them: the conversation is compressed into
-- one row here and its messages are removed from ride_messages. Nobody but
-- KidRide's safety team (an admin, through the API) can read it, and only to
-- look into an incident or a complaint.
--
-- One row per ride and driver (a ride that changed driver has one per driver).

create table if not exists public.ride_chat_archives (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides (id) on delete cascade,
  parent_id uuid references public.profiles (id) on delete set null,
  driver_id uuid references public.profiles (id) on delete set null,
  message_count integer not null check (message_count > 0),
  first_message_at timestamptz not null,
  last_message_at timestamptz not null,
  -- The conversation as JSON, gzip-compressed, in base64.
  transcript_gz text not null,
  archived_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists ride_chat_archives_ride_driver_idx on public.ride_chat_archives (ride_id, driver_id);

-- Same model as the other tables: apps never touch it directly; all reads and
-- writes go through the KidRide API (service role).
alter table public.ride_chat_archives enable row level security;
revoke all on public.ride_chat_archives from anon, authenticated;
grant all on public.ride_chat_archives to service_role;

notify pgrst, 'reload schema';
