-- ============================================
-- SELFIE ATTENDANCE — FULL SCHEMA (consolidated / current state)
-- ============================================
-- Yeh file ek NAYE Supabase project ke liye hai — agar tum scratch se
-- (naya device, naya Supabase account) setup kar rahe ho, to isse poori
-- file top-to-bottom ek baar SQL Editor mein run kar do. Isme structure,
-- security (RLS), aur tumhare 5 known sites already seed ho jayenge.
--
-- Apne EXISTING/live Supabase project par isse dobara MAT chalana —
-- tables already bani hui hain, dobara chalane se error aayega.
-- ============================================

-- ============================================
-- 1. TABLES
-- ============================================

create table if not exists plants (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  latitude double precision,
  longitude double precision,
  radius_meters integer not null default 150,
  created_at timestamptz default now()
);

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid references plants(id) not null,
  name text not null,
  email text unique not null,          -- must match their Gmail/Google login email
  device_id text,                       -- set automatically on first login
  device_fingerprint text,              -- backup device check (survives clearing site data)
  device_locked boolean default false,
  is_admin boolean default false,       -- true = can also open the Viewer dashboard
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references employees(id) not null,
  plant_id uuid references plants(id) not null,
  clock_in_time timestamptz default now(),
  attendance_date date default (timezone('Asia/Kolkata', now()))::date,
  latitude double precision not null,
  longitude double precision not null,
  gps_accuracy double precision,
  distance_meters double precision not null,
  within_range boolean not null,
  selfie_url text,                      -- storage path, not a public link (bucket is private)
  device_id text,
  device_mismatch_flag boolean default false,
  status text default 'pending_review', -- 'ok' | 'flagged' (clock-in)
  created_at timestamptz default now(),
  -- clock-out fields (same verification as clock-in, filled in later via UPDATE)
  clock_out_time timestamptz,
  clock_out_latitude double precision,
  clock_out_longitude double precision,
  clock_out_gps_accuracy double precision,
  clock_out_distance_meters double precision,
  clock_out_within_range boolean,
  clock_out_selfie_url text,
  clock_out_device_mismatch_flag boolean default false,
  clock_out_status text,
  constraint unique_employee_per_day unique (employee_id, attendance_date)
);

create table if not exists blocked_viewers (
  email text primary key,
  blocked_at timestamptz default now(),
  note text
);

-- ============================================
-- 2. STORAGE BUCKET (manual step — dashboard se karna hai)
-- ============================================
-- Supabase Dashboard → Storage → New bucket
--   Name: attendance-selfies
--   Public: OFF (private)
-- Yeh SQL se nahi banta, upar wale steps dashboard mein follow karo.

-- ============================================
-- 3. ROW LEVEL SECURITY
-- ============================================
alter table plants enable row level security;
alter table employees enable row level security;
alter table attendance enable row level security;
alter table blocked_viewers enable row level security;

-- PLANTS — sab dekh sakte hain, site info sensitive nahi hai
drop policy if exists "plants_select" on plants;
create policy "plants_select" on plants for select using (true);

-- EMPLOYEES
-- apna record hamesha dikhe (Employee tab ke liye, login ke turant baad chahiye)
drop policy if exists "employees_select_own" on employees;
create policy "employees_select_own" on employees
  for select using (lower(auth.jwt() ->> 'email') = lower(email));

-- poori list sirf kisi bhi logged-in Google user ko (Viewer dashboard ke liye)
drop policy if exists "employees_select_all_authenticated" on employees;
create policy "employees_select_all_authenticated" on employees
  for select to authenticated using (true);

-- apna device_id/fingerprint khud update kar sake (device binding ke liye)
drop policy if exists "employees_update_own_device" on employees;
create policy "employees_update_own_device" on employees
  for update using (lower(auth.jwt() ->> 'email') = lower(email))
  with check (lower(auth.jwt() ->> 'email') = lower(email));

-- ATTENDANCE
-- apni history hamesha dikhe (Employee tab ke "Recent Attendance" ke liye)
drop policy if exists "attendance_select_own" on attendance;
create policy "attendance_select_own" on attendance
  for select using (
    employee_id in (select id from employees where lower(email) = lower(auth.jwt() ->> 'email'))
  );

-- poori list sirf kisi bhi logged-in Google user ko (Viewer dashboard ke liye)
drop policy if exists "attendance_select_all_authenticated" on attendance;
create policy "attendance_select_all_authenticated" on attendance
  for select to authenticated using (true);

-- clock-in insert sirf logged-in user hi kar sake
drop policy if exists "attendance_insert_authenticated" on attendance;
create policy "attendance_insert_authenticated" on attendance
  for insert to authenticated with check (true);

-- clock-out apni hi row par update kar sake (row insert clock-in ke waqt ban chuki hoti hai)
drop policy if exists "attendance_update_own_clockout" on attendance;
create policy "attendance_update_own_clockout" on attendance
  for update to authenticated using (
    employee_id in (select id from employees where lower(email) = lower(auth.jwt() ->> 'email'))
  )
  with check (
    employee_id in (select id from employees where lower(email) = lower(auth.jwt() ->> 'email'))
  );

-- BLOCKED VIEWERS — koi bhi sirf apna khud ka block-status check kar sake
drop policy if exists "blocked_viewers_select_own" on blocked_viewers;
create policy "blocked_viewers_select_own" on blocked_viewers
  for select using (lower(auth.jwt() ->> 'email') = lower(email));

-- ============================================
-- 4. STORAGE POLICIES (bucket bana lene ke BAAD chalao)
-- ============================================
drop policy if exists "selfies_insert_authenticated" on storage.objects;
create policy "selfies_insert_authenticated" on storage.objects
  for insert to authenticated with check (bucket_id = 'attendance-selfies');

drop policy if exists "selfies_select_authenticated" on storage.objects;
create policy "selfies_select_authenticated" on storage.objects
  for select to authenticated using (bucket_id = 'attendance-selfies');

-- ============================================
-- 5. SEED DATA — apne 5 known sites (naye project mein already daal do)
-- ============================================
insert into plants (name, latitude, longitude, radius_meters) values
  ('24GreenPark',    21.942867, 70.050572, 150),
  ('Maruti Solar',   22.010581, 70.037650, 150),
  ('AGEPL Nandana',  21.981487, 70.055912, 150),
  ('AGEPL Dhrafa',   21.981819, 70.093543, 150),
  ('Office',         21.907182, 70.036780, 150)
on conflict (name) do nothing;

-- ============================================
-- 6. EMPLOYEES SEED — yeh tumhe khud generate karna hai (backup lete waqt)
-- ============================================
-- Employees baar-baar naam/email/plant badalte rehte hain, isliye yahan
-- ek fixed list rakhna galat ho sakta hai (outdated ho sakti hai).
--
-- Jab bhi tumhe apni CURRENT live employee list ka backup chahiye ho
-- (is file mein daalne ke liye), apne LIVE Supabase project mein yeh
-- query chalao — iska output ready-made INSERT statements dega jo
-- seedha copy-paste karke yahan neeche daal sakte ho:
--
--   select 'insert into employees (plant_id, name, email, is_admin, is_active) '
--     || 'select id, ''' || e.name || ''', ''' || e.email || ''', '
--     || e.is_admin || ', ' || e.is_active
--     || ' from plants where name = ''' || p.name || ''';' as insert_statement
--   from employees e join plants p on p.id = e.plant_id
--   order by p.name, e.name;
--
-- Result ka har row ek ready SQL statement hai — sabko copy karke
-- yahan neeche paste kar dena.
