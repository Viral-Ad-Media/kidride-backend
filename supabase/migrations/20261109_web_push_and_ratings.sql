-- Web push alerts and Uber/Bolt-style two-way ratings.
-- Safe to run more than once in the Supabase SQL Editor.

-- 1. Browser push subscriptions (one per browser/device a user turned alerts on in).
create table if not exists public.web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) between 10 and 1000),
  p256dh text not null check (char_length(p256dh) between 10 and 200),
  auth text not null check (char_length(auth) between 8 and 100),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default timezone('utc', now()),
  last_used_at timestamptz
);
create index if not exists web_push_subscriptions_user_idx on public.web_push_subscriptions (user_id);
alter table public.web_push_subscriptions enable row level security;
revoke all on public.web_push_subscriptions from anon, authenticated;
grant all on public.web_push_subscriptions to service_role;

-- 2. Parent -> driver ratings get compliment / issue tags (like Uber's "Great driving", "Clean car").
alter table public.ride_ratings add column if not exists tags text[] not null default '{}';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ride_ratings_tags_limit') then
    alter table public.ride_ratings add constraint ride_ratings_tags_limit check (cardinality(tags) <= 6);
  end if;
end $$;

-- 3. Driver -> family ratings (the driver rates the pickup: on time, ready, respectful).
create table if not exists public.family_ratings (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null unique references public.rides (id),
  driver_id uuid not null references public.profiles (id),
  parent_id uuid not null references public.profiles (id),
  stars smallint not null check (stars between 1 and 5),
  tags text[] not null default '{}' check (cardinality(tags) <= 6),
  comment text check (comment is null or char_length(comment) <= 500),
  created_at timestamptz not null default timezone('utc', now())
);
create index if not exists family_ratings_parent_idx on public.family_ratings (parent_id, created_at desc);
alter table public.family_ratings enable row level security;
revoke all on public.family_ratings from anon, authenticated;
grant all on public.family_ratings to service_role;
