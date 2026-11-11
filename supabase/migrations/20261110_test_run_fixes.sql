-- Fixes from the end-to-end test run (2026-11-10).
-- Run once in the Supabase SQL Editor. Safe to run again.

-- 1. Forgot password: one-time reset links (only the SHA-256 of the token is stored).
create table if not exists public.password_resets (
  token_hash text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists password_resets_user_idx on public.password_resets (user_id, created_at desc);
alter table public.password_resets enable row level security;
revoke all on public.password_resets from anon, authenticated;
grant all on public.password_resets to service_role;

-- 2. Per-document admin review of driver applications:
--    { kind: { status: 'approved' | 'reupload', note, path, by, at } }
alter table public.driver_applications add column if not exists document_reviews jsonb not null default '{}'::jsonb;

-- 3. Safety net for the column whose absence broke dispatch and face checks in run 4.
alter table public.driver_checks add column if not exists due_at timestamptz;
