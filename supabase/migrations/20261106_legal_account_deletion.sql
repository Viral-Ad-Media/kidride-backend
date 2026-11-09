-- Legal and account deletion: record which Terms/Privacy version a user agreed
-- to at sign-up, and when an account was deleted (anonymised).
alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists terms_version text;
alter table public.profiles add column if not exists deleted_at timestamptz;

create index if not exists profiles_deleted_at_idx on public.profiles (deleted_at) where deleted_at is not null;
