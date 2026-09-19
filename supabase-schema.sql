-- ============================================
-- ATTENDANCE SYSTEM — SUPABASE SCHEMA
-- Run this in Supabase Dashboard → SQL Editor
-- ============================================

-- 1. PLANTS TABLE
create table plants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  latitude double precision,
  longitude double precision,
  radius_meters integer not null default 150,
  created_at timestamptz default now()
);

-- Insert your 5 plants (latitude/longitude ko baad me update karna, filhaal null hain)
insert into plants (name) values
  ('24GreenPark'),
  ('Office'),
  ('Maruti Solar'),
  ('AGEPL Nandana'),
  ('AGEPL Dhrafa');

-- 2. EMPLOYEES TABLE
create table employees (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid references plants(id) not null,
  name text not null,
  email text unique not null,               -- must match their Gmail/Google login email
  device_id text,                           -- set automatically on first login
  device_locked boolean default false,      -- true once bound to a device
  is_active boolean default true,
  created_at timestamptz default now()
);

-- 3. ATTENDANCE TABLE
create table attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references employees(id) not null,
  plant_id uuid references plants(id) not null,
  clock_in_time timestamptz default now(),
  latitude double precision not null,
  longitude double precision not null,
  gps_accuracy double precision,            -- meters, for anomaly detection
  distance_meters double precision not null,
  within_range boolean not null,
  selfie_url text,                          -- link to Supabase Storage
  ip_address text,
  ip_location text,                         -- city/region from IP lookup
  ip_mismatch_flag boolean default false,   -- true if IP location far from GPS location
  device_id text,
  device_mismatch_flag boolean default false,
  status text default 'pending_review',     -- 'ok', 'flagged', 'pending_review'
  created_at timestamptz default now()
);

-- 4. STORAGE BUCKET FOR SELFIES
-- Supabase Dashboard → Storage → New Bucket → name: "attendance-selfies" (private, not public)
-- Yeh SQL editor se nahi hota, dashboard se manually bucket banana hoga.
-- Bucket banane ke baad, yeh policies chalao (storage.objects par):
create policy "Authenticated users can upload selfies" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'attendance-selfies');
create policy "Authenticated users can read selfies" on storage.objects
  for select to authenticated
  using (bucket_id = 'attendance-selfies');

-- 5. ROW LEVEL SECURITY (recommended)
alter table plants enable row level security;
alter table employees enable row level security;
alter table attendance enable row level security;

-- Anon key ko sirf zaroori operations allow karo (yeh baad me tighten karenge
-- jab Edge Function ready ho jaye — abhi ke liye basic policies):
create policy "Allow read plants" on plants for select using (true);
create policy "Allow employee read own record via authenticated email" on employees
  for select using (auth.jwt() ->> 'email' = email);
create policy "Allow employee update own device info" on employees
  for update using (auth.jwt() ->> 'email' = email)
  with check (auth.jwt() ->> 'email' = email);
create policy "Allow insert attendance if authenticated" on attendance
  for insert with check (auth.role() = 'authenticated');
create policy "Allow read own attendance" on attendance
  for select using (
    employee_id in (select id from employees where email = auth.jwt() ->> 'email')
  );

-- 6. UPDATE PLANT COORDINATES (fresh values from Google Maps)
update plants set latitude = 21.942867, longitude = 70.050572, radius_meters = 150
  where name = '24GreenPark';
update plants set latitude = 22.010581, longitude = 70.037650, radius_meters = 150
  where name = 'Maruti Solar';
update plants set latitude = 21.981487, longitude = 70.055912, radius_meters = 150
  where name = 'AGEPL Nandana';
update plants set latitude = 21.981819, longitude = 70.093543, radius_meters = 150
  where name = 'AGEPL Dhrafa';
update plants set latitude = 21.907182, longitude = 70.036780, radius_meters = 150
  where name = 'Office';

-- If you already ran an earlier version of this file where the 5th plant was
-- named 'Madhav Solar' instead of 'Office', run this once to fix it instead
-- of re-running the insert above (which would create a duplicate row):
-- update plants set name = 'Office' where name = 'Madhav Solar';

-- 7. INSERT EMPLOYEES
-- Emails marked "dummy" below are placeholders (not real inboxes) so Rahul
-- can test the flow end-to-end first. Replace each with the employee's real
-- Gmail later using: update employees set email = 'real@gmail.com' where name = '...';
insert into employees (plant_id, name, email)
  select id, e.name, e.email from plants,
  (values
    ('Sagar Chauhan', 'sagar.chauhan.dummy1@gmail.com'),
    ('Arun Dabhi', 'arun.dabhi.dummy2@gmail.com')
  ) as e(name, email)
  where plants.name = '24GreenPark';

insert into employees (plant_id, name, email)
  select id, e.name, e.email from plants,
  (values
    ('Vadecha Jayesh', 'jayesh.vadecha.dummy3@gmail.com'),
    ('Rohan', 'rohan.maruti.dummy4@gmail.com'),
    ('Nilesh Chauhan', 'nilesh.chauhan.dummy5@gmail.com')
  ) as e(name, email)
  where plants.name = 'Maruti Solar';

insert into employees (plant_id, name, email)
  select id, e.name, e.email from plants,
  (values
    ('Dabhecha Chirag', 'chirag.dabhecha.dummy6@gmail.com'),
    ('Sunil Zinzuvadiya', 'sunil.zinzuvadiya.dummy7@gmail.com')
  ) as e(name, email)
  where plants.name = 'AGEPL Nandana';

insert into employees (plant_id, name, email)
  select id, e.name, e.email from plants,
  (values
    ('Piyush Bera', 'piyush.bera.dummy8@gmail.com'),
    ('Ketan Sathalpara', 'ketan.sathalpara.dummy9@gmail.com')
  ) as e(name, email)
  where plants.name = 'AGEPL Dhrafa';

-- Rahul's real Gmail (Office plant) — this one is real, use it for testing
insert into employees (plant_id, name, email)
  select id, 'Rahul Chauhan', 'chauhanrahul2850@gmail.com'
  from plants where plants.name = 'Office';

-- ============================================
-- NOTE: Employee emails abhi khaali hain (email required hai, must match
-- their Gmail login exactly). Employee names aur unke Gmail address batao,
-- main INSERT/UPDATE statements bana dunga.
-- Plant latitude/longitude bhi batao (ya website se "use current location"
-- button se set kar sakte ho, phir yahan se copy kar lena).
--
-- GOOGLE OAUTH SETUP (do this in Supabase dashboard, one-time):
-- 1. Google Cloud Console → create project → OAuth consent screen → 
--    create OAuth Client ID (type: Web application)
-- 2. Authorized redirect URI: https://<your-project-ref>.supabase.co/auth/v1/callback
-- 3. Copy Client ID + Client Secret
-- 4. Supabase Dashboard → Authentication → Providers → Google → paste both → Save
-- ============================================
