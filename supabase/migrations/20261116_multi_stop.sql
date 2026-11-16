-- Extra stops on a ride: pickup -> stop 1 -> ... -> drop-off (up to 3 stops).
-- Each stop: { address, coords: { lat, lng }, note, childIds, status, arrivedAt, completedAt }
-- where status is pending | arrived | done. ride_series.stops holds the plan
-- (address, coords, note, childIds) copied onto every ride of a school week.
-- Until this runs, the API keeps working and refuses only bookings with stops.

alter table public.rides add column if not exists stops jsonb not null default '[]'::jsonb;
alter table public.ride_series add column if not exists stops jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rides_stops_check') then
    alter table public.rides add constraint rides_stops_check
      check (jsonb_typeof(stops) = 'array' and jsonb_array_length(stops) <= 3);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ride_series_stops_check') then
    alter table public.ride_series add constraint ride_series_stops_check
      check (jsonb_typeof(stops) = 'array' and jsonb_array_length(stops) <= 3);
  end if;
end $$;

-- The API reads the new column straight away.
notify pgrst, 'reload schema';
