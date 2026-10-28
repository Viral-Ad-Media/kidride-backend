-- In-app notifications (the bell in the app) and the per-user email switch.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  ride_id uuid references public.rides (id) on delete set null,
  kind text not null check (char_length(kind) between 1 and 40),
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 400),
  read_at timestamptz,
  email_sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx on public.notifications (user_id) where read_at is null;

-- Same model as the other tables: the owner may read; writes go through the API (service role).
alter table public.notifications enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notifications' and policyname = 'Users can read their notifications'
  ) then
    create policy "Users can read their notifications"
    on public.notifications
    for select
    to authenticated
    using (auth.uid() = user_id);
  end if;
end $$;

grant all on public.notifications to service_role;

-- Email on ride updates is on unless the user turns it off in Notification settings.
alter table public.profiles add column if not exists notify_email boolean not null default true;
