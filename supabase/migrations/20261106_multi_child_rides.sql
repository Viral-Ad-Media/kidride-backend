-- Several children in one ride. rides.child_id stays as the first child (older
-- code, FKs and reports keep working); rides.child_ids lists every child in the
-- car, first child first. One trip code covers the whole ride.

alter table public.rides add column if not exists child_ids uuid[];
update public.rides set child_ids = array[child_id] where child_ids is null or cardinality(child_ids) = 0;
alter table public.rides alter column child_ids set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rides_child_ids_check') then
    alter table public.rides add constraint rides_child_ids_check
      check (cardinality(child_ids) between 1 and 4 and child_ids[1] = child_id);
  end if;
end $$;

create index if not exists rides_child_ids_idx on public.rides using gin (child_ids);

-- Computed relationship so the API can select `children:ride_children(id, name, age)`
-- next to each ride, in booking order.
create or replace function public.ride_children(public.rides)
returns setof public.children
language sql stable set search_path = public
rows 4
as $$
  select c.* from public.children c
  join unnest($1.child_ids) with ordinality as k(id, n) on k.id = c.id
  order by k.n;
$$;

-- Only the API (service role) reads it.
revoke all on function public.ride_children(public.rides) from public, anon, authenticated;
grant execute on function public.ride_children(public.rides) to service_role;

notify pgrst, 'reload schema';
