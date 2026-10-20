-- Trusted contacts a parent keeps on the Safety page (up to 5, enforced by the API).

create table if not exists public.trusted_contacts (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles (id),
  name text not null check (char_length(name) between 1 and 100),
  phone text not null check (char_length(phone) between 7 and 20),
  relationship text check (relationship is null or char_length(relationship) <= 50),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists trusted_contacts_parent_id_idx on public.trusted_contacts (parent_id, created_at);

-- Same model as the other tables: the owner may read; writes go through the API (service role).
alter table public.trusted_contacts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'trusted_contacts' and policyname = 'Parents can read their trusted contacts'
  ) then
    create policy "Parents can read their trusted contacts"
    on public.trusted_contacts
    for select
    to authenticated
    using (auth.uid() = parent_id);
  end if;
end $$;

grant all on public.trusted_contacts to service_role;
