create table if not exists public.app_storage (
  key text not null,
  shared boolean not null default true,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (key, shared)
);

alter table public.app_storage enable row level security;

create policy "anonymous users can read shared app data"
  on public.app_storage for select
  to anon
  using (shared = true);

create policy "anonymous users can insert shared app data"
  on public.app_storage for insert
  to anon
  with check (shared = true);

create policy "anonymous users can update shared app data"
  on public.app_storage for update
  to anon
  using (shared = true)
  with check (shared = true);

create policy "anonymous users can delete shared app data"
  on public.app_storage for delete
  to anon
  using (shared = true);