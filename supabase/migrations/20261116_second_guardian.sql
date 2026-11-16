-- Second guardian: a parent (the family owner) invites one more adult who
-- shares the family's children, rides, tracking, alerts and booking.
-- Writes go through the API (service role); signed-in users may only read
-- their own links.

create table if not exists public.family_guardians (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  guardian_id uuid references public.profiles (id) on delete cascade,
  invitee_email text not null check (char_length(invitee_email) between 3 and 254),
  invitee_name text check (invitee_name is null or char_length(invitee_name) <= 80),
  relationship text check (relationship is null or char_length(relationship) <= 40),
  status text not null default 'pending' check (status in ('pending', 'active')),
  created_at timestamptz not null default timezone('utc', now()),
  accepted_at timestamptz,
  constraint family_guardians_active_has_guardian check (status = 'pending' or guardian_id is not null),
  constraint family_guardians_not_self check (guardian_id is null or guardian_id <> owner_id)
);

-- One family per guardian, one invite per email per family.
create unique index if not exists family_guardians_one_family_idx on public.family_guardians (guardian_id) where status = 'active';
create unique index if not exists family_guardians_owner_email_idx on public.family_guardians (owner_id, lower(invitee_email));
create index if not exists family_guardians_email_idx on public.family_guardians (lower(invitee_email)) where status = 'pending';

alter table public.family_guardians enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'family_guardians' and policyname = 'Members can read their family links'
  ) then
    create policy "Members can read their family links"
    on public.family_guardians
    for select
    to authenticated
    using (auth.uid() = owner_id or auth.uid() = guardian_id);
  end if;
end $$;

revoke insert, update, delete on public.family_guardians from anon, authenticated;
