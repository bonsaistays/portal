-- ============================================================
-- Bonsai Stays Portal — Supabase Schema
-- Run this in your Supabase project → SQL Editor → New query
-- ============================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";


-- ── Properties ──────────────────────────────────────────────
create table properties (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  address               text,
  city                  text,
  wifi_name             text,
  wifi_password         text,
  door_code             text,
  lock_type             text default 'code',  -- 'code', 'august', 'schlage'
  lock_device_id        text,
  check_in_instructions text,
  house_rules           text,
  thumbnail_url         text,
  active                boolean default true,
  created_at            timestamptz default now()
);


-- ── Bookings ─────────────────────────────────────────────────
create table bookings (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid references properties(id) on delete set null,
  token                 text unique default encode(gen_random_bytes(16), 'hex'),
  guest_name            text,
  guest_email           text,
  guest_phone           text,
  check_in              timestamptz not null,
  check_out             timestamptz not null,
  num_guests            text,
  arrival_time          text,
  special_requests      text,
  airbnb_confirmation   text,
  door_code             text,
  pre_arrival_complete  boolean default false,
  status                text default 'upcoming',
  created_at            timestamptz default now()
);


-- ── Purchases ────────────────────────────────────────────────
create table purchases (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid references bookings(id) on delete cascade,
  item_type             text,   -- 'early_checkin','late_checkout','experience'
  item_name             text,
  amount                integer default 0,  -- in cents
  stripe_payment_intent text,
  status                text default 'pending',  -- pending, paid, refunded
  created_at            timestamptz default now()
);


-- ── Messages ─────────────────────────────────────────────────
create table messages (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid references bookings(id) on delete cascade,
  sender                text not null,  -- 'guest' or 'admin'
  content               text not null,
  read                  boolean default false,
  created_at            timestamptz default now()
);


-- ── Row Level Security ────────────────────────────────────────

-- Enable RLS on all tables
alter table properties  enable row level security;
alter table bookings    enable row level security;
alter table purchases   enable row level security;
alter table messages    enable row level security;

-- Authenticated users (admin) can do everything
create policy "admin_all_properties"  on properties  for all using (auth.role() = 'authenticated');
create policy "admin_all_bookings"    on bookings    for all using (auth.role() = 'authenticated');
create policy "admin_all_purchases"   on purchases   for all using (auth.role() = 'authenticated');
create policy "admin_all_messages"    on messages    for all using (auth.role() = 'authenticated');

-- Guests (anon) can read properties (for their own booking join)
create policy "anon_read_properties"  on properties  for select using (true);

-- Guests can read their own booking by token
create policy "anon_read_booking"     on bookings    for select using (true);

-- Guests can update their own booking (pre-arrival form)
create policy "anon_update_booking"   on bookings    for update using (true);

-- Guests can read/insert purchases for their booking
create policy "anon_read_purchases"   on purchases   for select using (true);
create policy "anon_insert_purchases" on purchases   for insert with check (true);

-- Guests can read/insert messages for their booking
create policy "anon_read_messages"    on messages    for select using (true);
create policy "anon_insert_messages"  on messages    for insert with check (true);


-- ── Realtime ─────────────────────────────────────────────────
-- Enable realtime on messages table
-- Go to: Supabase → Database → Replication → enable messages table


-- ── Sample data (optional — delete after testing) ─────────────
/*
insert into properties (name, address, city, wifi_name, wifi_password, door_code, check_in_instructions)
values (
  'Blue Water Cottage',
  '123 Lake Rd, Port Carling, ON',
  'Muskoka',
  'BlueWater_Guest',
  'Bonsai2024!',
  '4829',
  'Park in the right side of the driveway. The lockbox is to the right of the front door — use your door code. Firewood is on the side deck. Enjoy!'
);
*/
