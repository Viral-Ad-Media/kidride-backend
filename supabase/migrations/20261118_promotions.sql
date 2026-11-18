-- Promotions an admin creates: a promo code a parent types when booking, or a
-- seasonal offer that applies on its own (no code). Each takes a percentage off
-- the fare for everyone, for new parents, or for chosen parents, between two
-- dates, and can be switched on and off. The driver is always paid in full: a
-- discount comes out of KidRide's share.

create table if not exists public.promotions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 2 and 80),
  -- Null for an offer that applies on its own. Otherwise what the parent types: capitals and digits.
  code text check (code is null or code ~ '^[A-Z0-9]{4,20}$'),
  percent_off numeric(5, 2) not null check (percent_off > 0 and percent_off <= 50),
  -- The most one ride can be reduced by; null for no limit.
  max_discount numeric(10, 2) check (max_discount is null or max_discount > 0),
  -- all: every parent. new: parents with no completed ride yet. selected: the parents in promotion_users.
  audience text not null default 'all' check (audience in ('all', 'new', 'selected')),
  starts_at timestamptz not null default timezone('utc', now()),
  ends_at timestamptz,
  max_uses_per_user integer check (max_uses_per_user is null or max_uses_per_user > 0),
  max_uses_total integer check (max_uses_total is null or max_uses_total > 0),
  active boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (ends_at is null or ends_at > starts_at)
);

create unique index if not exists promotions_code_idx on public.promotions (code) where code is not null;
create index if not exists promotions_active_idx on public.promotions (active) where active;

-- The chosen parents of a promotion whose audience is 'selected'.
create table if not exists public.promotion_users (
  promotion_id uuid not null references public.promotions (id) on delete cascade,
  parent_id uuid not null references public.profiles (id) on delete cascade,
  primary key (promotion_id, parent_id)
);

-- One row for each ride a promotion reduced.
create table if not exists public.promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions (id) on delete cascade,
  parent_id uuid not null references public.profiles (id) on delete cascade,
  ride_id uuid not null references public.rides (id) on delete cascade,
  amount numeric(10, 2) not null check (amount > 0),
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists promotion_redemptions_ride_idx on public.promotion_redemptions (ride_id);
create index if not exists promotion_redemptions_promotion_idx on public.promotion_redemptions (promotion_id, parent_id);

-- Same model as the other tables: apps never touch them directly; all reads
-- and writes go through the KidRide API (service role).
alter table public.promotions enable row level security;
alter table public.promotion_users enable row level security;
alter table public.promotion_redemptions enable row level security;
revoke all on public.promotions from anon, authenticated;
revoke all on public.promotion_users from anon, authenticated;
revoke all on public.promotion_redemptions from anon, authenticated;
grant all on public.promotions to service_role;
grant all on public.promotion_users to service_role;
grant all on public.promotion_redemptions to service_role;

notify pgrst, 'reload schema';
