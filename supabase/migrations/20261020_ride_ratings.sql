-- Parents rate the driver of a completed ride: 1-5 stars and an optional comment.

create table if not exists public.ride_ratings (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null unique references public.rides (id),
  parent_id uuid not null references public.profiles (id),
  driver_id uuid not null references public.profiles (id),
  stars smallint not null check (stars between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 500),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists ride_ratings_driver_id_idx on public.ride_ratings (driver_id, created_at desc);

-- Same model as rides: participants may read; all writes go through the API (service role).
alter table public.ride_ratings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ride_ratings' and policyname = 'Participants can read ride ratings'
  ) then
    create policy "Participants can read ride ratings"
    on public.ride_ratings
    for select
    to authenticated
    using (auth.uid() = parent_id or auth.uid() = driver_id);
  end if;
end $$;

grant all on public.ride_ratings to service_role;
