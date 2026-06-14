-- ============================================================
-- NoaPro Caller — Supabase schema
-- Run this once in your Supabase project:
--   Dashboard → SQL Editor → New query → paste → Run
-- ============================================================

-- ---------- PROFILES (one row per caller) -------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default 'Caller',
  initials    text not null default '??',
  color       text not null default '#0d7d6b',
  created_at  timestamptz not null default now()
);

-- Auto-create a profile whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, initials)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    upper(left(coalesce(new.raw_user_meta_data->>'full_name', new.email), 2))
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- LEADS (the shared call list) --------------------
-- status is constrained to your team's outcome set.
create table if not exists public.leads (
  id            uuid primary key default gen_random_uuid(),
  business      text not null,
  phone         text,
  category      text,
  area          text,
  status        text not null default 'New'
                check (status in (
                  'New','Calling','No answer','Voicemail left','Callback',
                  'Not interested','Wrong number','Do not call','Signed up'
                )),
  claimed_by    uuid references public.profiles(id) on delete set null,
  claimed_at    timestamptz,
  assigned_to   uuid references public.profiles(id) on delete set null,
  last_called_at timestamptz,
  callback_at   timestamptz,
  notes         text,
  source_file   text,
  created_at    timestamptz not null default now()
);
create index if not exists leads_status_idx on public.leads(status);
create index if not exists leads_claimed_idx on public.leads(claimed_by);
create index if not exists leads_callback_idx on public.leads(callback_at);

-- ---------- CALL LOG (one row per dial) ---------------------
create table if not exists public.call_log (
  id          bigint generated always as identity primary key,
  lead_id     uuid references public.leads(id) on delete cascade,
  caller_id   uuid references public.profiles(id) on delete set null,
  outcome     text not null,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists call_log_created_idx on public.call_log(created_at);
create index if not exists call_log_caller_idx on public.call_log(caller_id);

-- ============================================================
-- ROW-LEVEL SECURITY
-- 4-person trusted team: any signed-in caller can read/write.
-- (Tighten later if you ever add non-caller accounts.)
-- ============================================================
alter table public.profiles enable row level security;
alter table public.leads    enable row level security;
alter table public.call_log enable row level security;

drop policy if exists "auth read profiles"  on public.profiles;
drop policy if exists "auth edit own profile" on public.profiles;
create policy "auth read profiles"   on public.profiles for select to authenticated using (true);
create policy "auth edit own profile" on public.profiles for update to authenticated using (auth.uid() = id);

drop policy if exists "auth all leads" on public.leads;
create policy "auth all leads" on public.leads for all to authenticated using (true) with check (true);

drop policy if exists "auth all calllog" on public.call_log;
create policy "auth all calllog" on public.call_log for all to authenticated using (true) with check (true);

-- ============================================================
-- REALTIME — push live changes to all connected callers
-- ============================================================
alter publication supabase_realtime add table public.leads;
alter publication supabase_realtime add table public.call_log;

-- ============================================================
-- STORAGE — private bucket for scripts / CSVs / info docs
-- ============================================================
insert into storage.buckets (id, name, public)
values ('files','files', false)
on conflict (id) do nothing;

drop policy if exists "auth read files"   on storage.objects;
drop policy if exists "auth write files"  on storage.objects;
drop policy if exists "auth delete files" on storage.objects;
create policy "auth read files"   on storage.objects for select to authenticated using (bucket_id = 'files');
create policy "auth write files"  on storage.objects for insert to authenticated with check (bucket_id = 'files');
create policy "auth delete files" on storage.objects for delete to authenticated using (bucket_id = 'files');

-- ============================================================
-- SEED — a few sample leads so the queue isn't empty.
-- Delete these once you import your real list.
-- ============================================================
insert into public.leads (business, phone, category, area, status) values
  ('Brightwave Plumbing', '01622 555 0148', 'Plumber',      'Maidstone',  'New'),
  ('Apex Electrical Ltd',  '01634 555 0192', 'Electrician',  'Gillingham', 'Callback'),
  ('Coastline Roofing',    '01227 555 0173', 'Roofer',       'Whitstable', 'No answer'),
  ('Medway Locks',         '01634 555 0110', 'Locksmith',    'Rochester',  'Voicemail left'),
  ('SparkSafe Heating',    '01795 555 0166', 'Gas engineer', 'Faversham',  'New'),
  ('Garden Kings',         '01634 555 0144', 'Landscaper',   'Chatham',    'New')
on conflict do nothing;
