# Database Cheatsheet — Selfie Attendance

Yeh sab commands **Supabase Dashboard → SQL Editor** mein chalane hain.
Koi bhi code change ya GitHub push zaroori nahi in mein se kisi ke liye.

---

## Site (Plant) Management

**Naya site add karna**
```sql
insert into plants (name, latitude, longitude, radius_meters)
values ('Naya Site', 21.xxxxxx, 70.xxxxxx, 150);
```

**Site ka naam rename karna**
```sql
update plants set name = 'Naya Naam' where name = 'Purana Naam';
```

**Site ki location (lat/long) change karna**
```sql
update plants
set latitude = 21.xxxxxx, longitude = 70.xxxxxx
where name = 'Site Ka Naam';
```

**Site ka allowed radius change karna**
```sql
update plants set radius_meters = 200 where name = 'Site Ka Naam';
```

**Poora site delete karna** (pehle uske employees handle karo)
```sql
update employees set is_active = false where plant_id = (select id from plants where name = 'Site Ka Naam');
delete from plants where name = 'Site Ka Naam';
```

---

## Employee Management

**Naya employee add karna**
```sql
insert into employees (plant_id, name, email)
select id, 'Employee Ka Naam', 'unka.email@gmail.com'
from plants where name = 'Site Ka Naam';
```

**Employee ka naam rename karna**
```sql
update employees set name = 'Naya Naam' where email = 'unka.email@gmail.com';
```

**Employee ka Gmail change karna**
```sql
update employees set email = 'naya.email@gmail.com' where name = 'Employee Ka Naam';
```

**Employee ko doosre site par transfer karna**
```sql
update employees set plant_id = (select id from plants where name = 'Naya Site')
where name = 'Employee Ka Naam';
```

**Employee remove karna — soft (recommended, history preserve rehti hai)**
```sql
update employees set is_active = false where name = 'Employee Ka Naam';
```

**Deactivate kiye hue employee ko wapas active karna**
```sql
update employees set is_active = true where name = 'Employee Ka Naam';
```

**Employee permanent delete karna** (history bhi chali jayegi — careful)
```sql
delete from attendance where employee_id = (select id from employees where name = 'Employee Ka Naam');
delete from employees where name = 'Employee Ka Naam';
```

**Employee ka device-lock reset karna** (naya phone mila ho, ya galti se flag laga ho)
```sql
update employees set device_id = null, device_locked = false, device_fingerprint = null
where name = 'Employee Ka Naam';
```

---

## Attendance Records

**Aaj kisne clock-in nahi kiya (sab sites)**
```sql
select p.name as site, e.name as employee
from employees e
join plants p on p.id = e.plant_id
where e.is_active = true
and e.id not in (
  select employee_id from attendance where attendance_date = current_date
);
```

**Kisi ek employee ki pichhle 30 din ki history**
```sql
select attendance_date, clock_in_time, distance_meters, status
from attendance
where employee_id = (select id from employees where name = 'Employee Ka Naam')
order by attendance_date desc limit 30;
```

**Ek flagged record ko manually "OK" karna** (review ke baad genuine lage to)
```sql
update attendance
set status = 'ok', device_mismatch_flag = false
where id = 'record-ki-id'; -- Table Editor se id copy karo
```

**Galat/test entry delete karna**
```sql
delete from attendance where id = 'record-ki-id';
```

---

## Viewer Access / Block List

**Kisi ko Viewer dashboard se block karna**
```sql
insert into blocked_viewers (email) values ('unka.email@gmail.com');
```

**Unblock karna**
```sql
delete from blocked_viewers where email = 'unka.email@gmail.com';
```

**Kaun-kaun block hai, list dekhna**
```sql
select * from blocked_viewers;
```

---

## Google Login — naye Gmail ke liye (sirf agar app "Testing" mode mein ho)

Google Cloud Console → **APIs & Services → OAuth consent screen** → **Publishing status** check karo:

- **"In production"** ho to → koi bhi Gmail login kar sakta hai, kuch add karne ki zaroorat nahi (bas pehli baar ek "Google hasn't verified this app" warning dikhegi, "Advanced → Continue" dabana hoga).
- **"Testing"** ho to → naye Gmail ko pehle whitelist karna hoga:
  1. Google Cloud Console → **OAuth consent screen** → **Test users** section
  2. **"+ ADD USERS"** → naya email daalo → **Save**
  3. Uske baad hi wo Gmail login kar payega (max 100 users allowed)

---

## Confirm karne ke liye handy checks

**Kisi employee ka pura record dekhna**
```sql
select * from employees where name = 'Employee Ka Naam';
```

**Kisi ka admin/viewer status check karna**
```sql
select name, email, is_admin from employees where email = 'unka.email@gmail.com';
```

**Saari RLS policies ki list** (troubleshooting ke liye)
```sql
select schemaname, tablename, policyname from pg_policies
where tablename in ('plants','employees','attendance','blocked_viewers')
or (schemaname = 'storage' and tablename = 'objects');
```
