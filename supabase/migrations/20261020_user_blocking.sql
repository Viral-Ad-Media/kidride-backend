-- Admin user management: blockable accounts and recorded review decisions.

alter table public.profiles add column if not exists is_blocked boolean not null default false;
alter table public.profiles add column if not exists blocked_reason text;
alter table public.profiles add column if not exists blocked_at timestamptz;

-- Why an application was rejected or an approval withdrawn, and when it was decided.
alter table public.driver_applications add column if not exists review_note text;
alter table public.driver_applications add column if not exists reviewed_at timestamptz;

-- Admin Drivers / Parents lists filter by role and sort by join date.
create index if not exists profiles_role_created_idx on public.profiles (role, created_at desc);
