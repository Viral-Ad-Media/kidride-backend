-- Card payments and driver payouts (Stripe). Run once in the Supabase SQL Editor. Safe to run again.
-- Nothing reads these tables until STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are set on the backend.

-- One row per user: a parent's Stripe customer and saved card (brand and last 4 only;
-- card numbers never reach KidRide), a driver's Stripe Express payout account.
create table if not exists public.payment_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  stripe_customer_id text unique,
  default_payment_method text,
  card_brand text,
  card_last4 text,
  card_exp_month smallint,
  card_exp_year smallint,
  stripe_account_id text unique,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  payout_requirements text[] not null default '{}',
  updated_at timestamptz not null default timezone('utc', now())
);

-- One row per paid ride: the card hold / charge and the driver's payout.
create table if not exists public.ride_payments (
  ride_id uuid primary key references public.rides (id) on delete cascade,
  parent_id uuid references public.profiles (id) on delete set null,
  driver_id uuid references public.profiles (id) on delete set null,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  purpose text check (purpose in ('ride_fare', 'cancellation_fee', 'no_show_fee')),
  status text not null default 'none' check (status in ('none', 'authorized', 'requires_action', 'processing', 'succeeded', 'failed', 'canceled')),
  payment_intent_id text,
  charge_id text,
  amount_authorized numeric(10, 2) not null default 0,
  amount_due numeric(10, 2) not null default 0,
  amount_charged numeric(10, 2) not null default 0,
  amount_refunded numeric(10, 2) not null default 0,
  last_refund_id text,
  last_error text,
  disputed boolean not null default false,
  payout_amount numeric(10, 2) not null default 0,
  payout_status text not null default 'none' check (payout_status in ('none', 'pending', 'paid', 'failed')),
  payout_error text,
  payout_reversed numeric(10, 2) not null default 0,
  transfer_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index if not exists ride_payments_parent_status_idx on public.ride_payments (parent_id, status);
create index if not exists ride_payments_driver_payout_idx on public.ride_payments (driver_id, payout_status);
create index if not exists ride_payments_intent_idx on public.ride_payments (payment_intent_id);

-- Stripe webhook events already handled (Stripe can send an event more than once).
create table if not exists public.payment_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default timezone('utc', now())
);

-- Only the backend (service role) reads or writes payment data.
alter table public.payment_accounts enable row level security;
alter table public.ride_payments enable row level security;
alter table public.payment_events enable row level security;
revoke all on public.payment_accounts, public.ride_payments, public.payment_events from anon, authenticated;
grant all on public.payment_accounts, public.ride_payments, public.payment_events to service_role;
