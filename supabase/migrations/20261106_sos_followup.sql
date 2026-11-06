-- SOS follow-up: trusted contacts can have an email so an SOS reaches them, and
-- each SOS gets a private live-location link (only the SHA-256 of the token is
-- stored; the link stops working when it expires or support marks it handled).

alter table public.trusted_contacts add column if not exists email text
  check (email is null or (char_length(email) <= 254 and email like '%_@_%'));

alter table public.ride_incidents add column if not exists share_token_hash text;
alter table public.ride_incidents add column if not exists share_expires_at timestamptz;
create unique index if not exists ride_incidents_share_token_idx on public.ride_incidents (share_token_hash) where share_token_hash is not null;
-- How many trusted contacts the SOS was emailed to (shown to support).
alter table public.ride_incidents add column if not exists contacts_notified smallint;
