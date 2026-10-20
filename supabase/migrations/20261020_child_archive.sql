-- Parents can remove a child profile. A child with past rides is archived
-- instead (rides keep pointing at them for history); archived children are
-- hidden from the parent's list and cannot be booked.

alter table public.children add column if not exists archived_at timestamptz;

create index if not exists children_parent_active_idx on public.children (parent_id, created_at) where archived_at is null;
