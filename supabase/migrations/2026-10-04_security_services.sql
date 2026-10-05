begin;
-- Abort rather than silently cancel live rides when an existing account has duplicates.
create unique index if not exists rides_one_active_driver on public.rides(driver_id) where driver_id is not null and status not in ('completed','cancelled');
create unique index if not exists rides_one_active_parent on public.rides(parent_id) where status not in ('completed','cancelled');
alter table public.rides add column if not exists driver_location jsonb;

-- All writes go through authenticated server endpoints using the service role.
-- Broad participant policies must not allow direct role/verification/status edits.
revoke insert, update, delete on public.profiles, public.children, public.rides, public.ride_declines from anon, authenticated;
drop policy if exists "Users can update their own profile" on public.profiles;
drop policy if exists "Parents can create their children" on public.children;
drop policy if exists "Parents can update their children" on public.children;
drop policy if exists "Parents can request rides" on public.rides;
drop policy if exists "Participants can update rides" on public.rides;
drop policy if exists "Drivers can create their declines" on public.ride_declines;

create table if not exists public.push_tokens (
 token text primary key, user_id uuid not null references public.profiles(id) on delete cascade,
 platform text not null check(platform in ('ios','android')), created_at timestamptz not null default now()
);
create index if not exists push_tokens_user_idx on public.push_tokens(user_id);
create table if not exists public.push_receipts (
 ticket_id text primary key, token text not null, created_at timestamptz not null default now()
);
create table if not exists public.driver_applications (
 driver_id uuid primary key references public.profiles(id) on delete cascade,
 documents jsonb not null, submitted_at timestamptz not null default now()
);
-- Serialize submissions and reviews; approval applies only to documents the operator viewed.
create or replace function public.submit_driver_application(applicant_id uuid, application_documents jsonb, applicant_phone text, applicant_vehicle jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
 perform 1 from public.profiles where id=applicant_id and role='driver' for update;
 if not found then raise exception 'Driver account required'; end if;
 insert into public.driver_applications(driver_id,documents,submitted_at) values(applicant_id,application_documents,clock_timestamp())
 on conflict(driver_id) do update set documents=excluded.documents,submitted_at=excluded.submitted_at;
 update public.profiles set phone=applicant_phone,vehicle=applicant_vehicle,is_verified_driver=false,driver_application_status='pending',updated_at=now() where id=applicant_id;
end; $$;
create or replace function public.review_driver_application(applicant_id uuid, reviewed_submission timestamptz, review_status text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
 if review_status not in ('approved','rejected') then raise exception 'Invalid review status'; end if;
 perform 1 from public.profiles where id=applicant_id and role='driver' and driver_application_status='pending' for update;
 if not found then return false; end if;
 perform 1 from public.driver_applications where driver_id=applicant_id and submitted_at=reviewed_submission;
 if not found then return false; end if;
 update public.profiles set is_verified_driver=(review_status='approved'),driver_application_status=review_status,updated_at=now() where id=applicant_id;
 return true;
end; $$;
revoke all on function public.submit_driver_application(uuid,jsonb,text,jsonb), public.review_driver_application(uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.submit_driver_application(uuid,jsonb,text,jsonb), public.review_driver_application(uuid,timestamptz,text) to service_role;

create table if not exists public.request_limits (
 key text primary key, count integer not null, expires_at timestamptz not null
);
alter table public.push_tokens enable row level security;
alter table public.push_receipts enable row level security;
alter table public.driver_applications enable row level security;
alter table public.request_limits enable row level security;
revoke all on public.push_tokens, public.push_receipts, public.driver_applications, public.request_limits from anon, authenticated;
grant all on public.push_tokens, public.push_receipts, public.driver_applications, public.request_limits to service_role;
create or replace function public.consume_rate_limit(bucket_key text, duration_ms integer)
returns integer language plpgsql security definer set search_path = public as $$
declare result integer;
begin
 if duration_ms <= 0 or duration_ms > 86400000 or length(bucket_key) != 64 then raise exception 'Invalid rate limit'; end if;
 insert into public.request_limits(key,count,expires_at) values(bucket_key,1,now()+duration_ms*interval '1 millisecond')
 on conflict(key) do update set count=case when request_limits.expires_at <= now() then 1 else request_limits.count+1 end,
 expires_at=case when request_limits.expires_at <= now() then now()+duration_ms*interval '1 millisecond' else request_limits.expires_at end
 returning count into result;
 -- Bounded opportunistic pruning, with hash keys to avoid storing raw IPs.
 delete from public.request_limits where key in (select key from public.request_limits where expires_at < now() limit 100);
 return result;
end; $$;
revoke all on function public.consume_rate_limit(text,integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text,integer) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('driver-verification','driver-verification',false,5242880,array['image/jpeg','image/png','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=excluded.allowed_mime_types;
-- No public storage policies: short-lived signed uploads/downloads only.
commit;
