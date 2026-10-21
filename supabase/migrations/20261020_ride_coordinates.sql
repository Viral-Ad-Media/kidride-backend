-- Coordinates chosen with Google Places at booking, used for the live map and
-- (later) nearest-driver matching. Shape: {"lat": number, "lng": number}.
-- Nullable: rides booked by typing an address without picking a suggestion have none.

alter table public.rides add column if not exists pickup_coords jsonb;
alter table public.rides add column if not exists dropoff_coords jsonb;
