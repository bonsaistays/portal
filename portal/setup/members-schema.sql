-- ═══════════════════════════════════════════════════════════
-- Bonsai Stays — Members, Businesses & Points Schema
-- Run in Supabase SQL Editor (New Query → Paste → Run)
-- ═══════════════════════════════════════════════════════════

-- Members table
create table if not exists members (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete set null,
  name            text not null,
  email           text unique not null,
  phone           text,
  member_number   text unique not null,  -- e.g. BV-000123
  member_since    timestamptz default now(),
  tier            text default 'Black' check (tier in ('Black','Gold','Platinum')),
  points          integer default 0,
  total_stays     integer default 0,
  created_at      timestamptz default now()
);

-- Businesses table
create table if not exists businesses (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  category        text not null,   -- e.g. Food & Drink, Activities, Spa, Shopping
  region          text not null,   -- e.g. Muskoka, Collingwood, Toronto
  description     text,
  address         text,
  phone           text,
  website         text,
  photo_url       text,
  deal_description text,
  deal_code       text,
  active          boolean default true,
  created_at      timestamptz default now()
);

-- Points history table
create table if not exists points_history (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid references members(id) on delete cascade,
  points      integer not null,              -- positive = earned, negative = spent
  type        text not null,                 -- 'earned', 'bonus', 'redeemed', 'adjusted'
  description text not null,
  booking_id  uuid references bookings(id) on delete set null,
  created_at  timestamptz default now()
);

-- ═══ Row Level Security ═══════════════════════════════════

alter table members       enable row level security;
alter table businesses    enable row level security;
alter table points_history enable row level security;

-- Members: admin (authenticated) full access
create policy "admin_members_all" on members
  for all to authenticated using (true) with check (true);

-- Members: anon can select own record by email (for PWA login lookup)
create policy "anon_members_select" on members
  for select to anon using (true);

-- Members: anon can insert (new member on first login)
create policy "anon_members_insert" on members
  for insert to anon with check (true);

-- Members: anon can update own record
create policy "anon_members_update" on members
  for update to anon using (true) with check (true);

-- Businesses: admin full access
create policy "admin_businesses_all" on businesses
  for all to authenticated using (true) with check (true);

-- Businesses: anon can read active businesses
create policy "anon_businesses_select" on businesses
  for select to anon using (active = true);

-- Points history: admin full access
create policy "admin_points_all" on points_history
  for all to authenticated using (true) with check (true);

-- Points history: anon can read own points (by member_id)
create policy "anon_points_select" on points_history
  for select to anon using (true);

-- Points history: anon can insert (earn points on booking completion)
create policy "anon_points_insert" on points_history
  for insert to anon with check (true);

-- ═══ Helper function: auto-generate member number ═════════
create or replace function generate_member_number()
returns text language plpgsql as $$
declare
  seq int;
begin
  select count(*) + 1 into seq from members;
  return 'BV-' || lpad(seq::text, 6, '0');
end;
$$;
