-- Monthly family plans (Stripe Billing). Run once in the Supabase SQL Editor, after payments.sql. Safe to run again.
-- Nothing changes for parents until the Stripe keys are set on the backend.

-- The plan tiers the admin edits on the Pricing page (one row, like pricing_settings).
create table if not exists public.subscription_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now())
);

-- One row per parent: their current plan, its terms as they were when they joined, and Stripe's status.
create table if not exists public.parent_subscriptions (
  parent_id uuid primary key references public.profiles (id) on delete cascade,
  plan_id text not null,
  terms jsonb not null default '{}'::jsonb,
  status text not null default 'incomplete' check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  stripe_subscription_id text unique,
  stripe_checkout_session_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- The plan discount given on a ride (0 = none). The driver's earnings are never reduced.
alter table public.rides add column if not exists subscription_discount numeric(10, 2) not null default 0;
create index if not exists rides_parent_discounted_idx on public.rides (parent_id, pickup_time) where subscription_discount > 0;

-- Only the backend (service role) reads or writes plans.
alter table public.subscription_settings enable row level security;
alter table public.parent_subscriptions enable row level security;
revoke all on public.subscription_settings, public.parent_subscriptions from anon, authenticated;
grant all on public.subscription_settings, public.parent_subscriptions to service_role;
