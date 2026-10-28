-- Distance- and time-based fares. One settings row the admin edits; each ride
-- keeps the quoted fare, its breakdown and the driver's share.

create table if not exists public.pricing_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now())
);
-- Only the API (service role) reads or writes pricing.
alter table public.pricing_settings enable row level security;

alter table public.rides add column if not exists currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$');
alter table public.rides add column if not exists fare_breakdown jsonb;
alter table public.rides add column if not exists driver_earnings numeric(10, 2) check (driver_earnings is null or driver_earnings >= 0);
alter table public.rides add column if not exists cancellation_fee numeric(10, 2) not null default 0 check (cancellation_fee >= 0);

-- Drivers earn their share, not the whole fare. Older flat-price rides have no share recorded.
create or replace function public.driver_ride_summary(p_driver uuid)
returns table (completed_count bigint, total_earnings numeric)
language sql stable security definer set search_path = public as $$
  select count(*), coalesce(sum(coalesce(driver_earnings, price)), 0)
  from public.rides
  where driver_id = p_driver and status = 'completed';
$$;
revoke all on function public.driver_ride_summary(uuid) from public, anon, authenticated;
grant execute on function public.driver_ride_summary(uuid) to service_role;
