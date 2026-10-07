# Database Cheatsheet — Selfie Attendance

Yeh sab commands **Supabase Dashboard → SQL Editor** mein chalane hain.
Koi bhi code change ya GitHub push zaroori nahi in mein se kisi ke liye.

**Jump to:**
[Site Management](#site-plant-management) ·
[Employee Management](#employee-management) ·
[Attendance Records](#attendance-records) ·
[Attendance Correction](#attendance-correction--presentabsent-badalna-punches-fix-karna) ·
[Viewer / Block List](#viewer-access--block-list) ·
[Admin Panel](#admin-panel) ·
[Google Login](#google-login--naye-gmail-ke-liye-sirf-agar-app-testing-mode-mein-ho) ·
[Handy Checks](#confirm-karne-ke-liye-handy-checks) ·
[Regions / Sarla](#regions-jamjodhpur--sarla-aur-3-punch-sites) ·
[Reports & Queries](#reports--queries) ·
[Bulk Operations](#bulk-operations-saavdhani-se-use-karna)

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

## Attendance Correction — Present/Absent badalna, punches fix karna

**Jo bilkul absent tha (koi record hi nahi) use us din "Present" karna**
Genuinely site par tha par kisi wajah se (phone issue, bhool gaya) clock-in nahi kar paya, aur manually present maarna hai:
```sql
insert into attendance (
  employee_id, plant_id, attendance_date, clock_in_time,
  latitude, longitude, distance_meters, within_range, status
)
select
  e.id, e.plant_id, 'YYYY-MM-DD', 'YYYY-MM-DD 09:00:00+05:30',
  p.latitude, p.longitude, 0, true, 'ok'
from employees e join plants p on p.id = e.plant_id
where e.name = 'Employee Ka Naam';
```
(Selfie column khaali rahega — Viewer mein "View" button is entry ke liye kaam nahi karega, bas status Present dikhega. Time 09:00 ki jagah jo bhi sahi ho daal dena.)

**Jo "Absent" dikh raha hai kyunki range se bahar clock-in hua tha, use Present karna**
```sql
update attendance
set within_range = true, status = 'ok'
where employee_id = (select id from employees where name = 'Employee Ka Naam')
and attendance_date = 'YYYY-MM-DD';
```

**Present ko Absent karna** — do tarike:

*Within-range flag hata ke "out of range" dikhana (record rehta hai, selfie/location sab dikhti hai):*
```sql
update attendance
set within_range = false, status = 'flagged'
where employee_id = (select id from employees where name = 'Employee Ka Naam')
and attendance_date = 'YYYY-MM-DD';
```

*Record hi poora hata dena (bilkul "no entry" jaisa, selfie bhi chali jayegi):*
```sql
delete from attendance
where employee_id = (select id from employees where name = 'Employee Ka Naam')
and attendance_date = 'YYYY-MM-DD';
```

**Chhuti hui Dopahar (mid) ya Clock-Out punch manually fill karna** (Sarla jaise 3-punch sites ke liye)
```sql
update attendance
set mid_time = 'YYYY-MM-DD 13:00:00+05:30', mid_status = 'ok', mid_within_range = true
where employee_id = (select id from employees where name = 'Employee Ka Naam')
and attendance_date = 'YYYY-MM-DD';
```
Clock-out ke liye `mid_*` ki jagah `clock_out_*` columns use karo (`clock_out_time`, `clock_out_status`, `clock_out_within_range`).

**Kisi punch ko wapas "nahi hua" banana** (galti se fill ho gaya ho)
```sql
update attendance
set mid_time = null, mid_status = null, mid_within_range = null
where employee_id = (select id from employees where name = 'Employee Ka Naam')
and attendance_date = 'YYYY-MM-DD';
```

**Galat date par chali gayi entry ko sahi date par move karna**
```sql
update attendance
set attendance_date = 'SAHI-DATE', clock_in_time = 'SAHI-DATE 09:00:00+05:30'
where id = 'record-ki-id';
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

**Kisi ka admin status check karna** (naya `admins` table se — niche "Admin Panel" section dekho)
```sql
select * from admins where email = 'unka.email@gmail.com';
```

**Saari RLS policies ki list** (troubleshooting ke liye)
```sql
select schemaname, tablename, policyname from pg_policies
where tablename in ('plants','employees','attendance','blocked_viewers')
or (schemaname = 'storage' and tablename = 'objects');
```

---

## Regions (Jamjodhpur / Sarla) aur 3-punch sites

Har site ka ek `region` hota hai. **Registered employee** (Rahul, Ajay, ...) Viewer kholte hi seedha apni khud ki region ka dashboard dekhta hai — koi choice screen nahi, aur doosri region ka data kabhi nahi dikhta. **Unregistered/outsider Gmail** Viewer kholta hai to usse Jamjodhpur/Sarla dono options milte hain, wo kisi ko bhi dekh sakta hai. Employee tab (clock-in/out) hamesha employee ki apni assigned site par hi kaam karta hai, region choose karne ka sawal hi nahi aata. Region list DB se automatically banti hai, naya region add karne ke liye code change nahi chahiye.

**Naya site kisi region mein add karna**
```sql
insert into plants (name, latitude, longitude, radius_meters, region, punches_per_day)
values ('Site Ka Naam', 21.xxxxxx, 70.xxxxxx, 400, 'Sarla', 3);
```

**`punches_per_day`:** `2` = Clock In + Clock Out. `3` = Clock In + Dopahar + Clock Out.

**Kisi site ko 2 se 3 punch (ya wapas) karna**
```sql
update plants set punches_per_day = 3 where name = 'Site Ka Naam';
```

**Site ko doosre region mein shift karna**
```sql
update plants set region = 'Sarla' where name = 'Site Ka Naam';
```

**Sarla mein naya employee add karna**
```sql
insert into employees (plant_id, name, email)
select id, 'Employee Ka Naam', 'unka.email@gmail.com'
from plants where name = 'AGEPL Sarla';
```

---

## Admin Panel

Website par ab landing screen se **"Admin Panel"** ek alag, teesra option hai (Employee/Viewer ke saath). Jo bhi Gmail `admins` table mein ho wo isse khol sakta hai — **koi employee hona zaroori nahi hai**. Andar se sirf **Sarla** ke employees manage hote hain (add / soft-remove / email change) — Jamjodhpur is panel se touch nahi hota.

`is_admin` column (employees table wala) ab **vestigial/unused** hai — admin status poori tarah is naye `admins` table se control hota hai.

**Naya admin add karna**
```sql
insert into admins (email) values ('unka.email@gmail.com')
on conflict (email) do nothing;
```

**Sab admins ki list**
```sql
select email, added_at, note from admins order by added_at;
```

**Kisi ko admin se hatana**
```sql
delete from admins where email = 'unka.email@gmail.com';
```

**Note likhna kisi admin ke against** (optional, sirf apne record ke liye — jaise "kis wajah se admin banaya")
```sql
update admins set note = 'Sarla site supervisor' where email = 'unka.email@gmail.com';
```

**Sarla employee add/remove/email-change** — ab ye seedha **website ke Admin Panel** se ho jata hai (koi SQL zaroori nahi), lekin fallback ke liye SQL commands "Employee Management" section mein already hain (upar dekho).

---

## Reports & Queries

**Kisi ek employee ki ek poore mahine ki attendance**
```sql
select attendance_date, clock_in_time, mid_time, clock_out_time, within_range, status
from attendance
where employee_id = (select id from employees where name = 'Employee Ka Naam')
and attendance_date >= 'YYYY-MM-01' and attendance_date < 'YYYY-MM-01'::date + interval '1 month'
order by attendance_date;
```

**Har employee ke total "Present" din kisi date range mein**
```sql
select e.name, count(*) as present_days
from attendance a join employees e on e.id = a.employee_id
where a.within_range = true
and a.attendance_date between 'START-DATE' and 'END-DATE'
group by e.name
order by e.name;
```

**Kisi ek site ka aaj ka live status (sab employees, Present/Absent)**
```sql
select e.name,
  case when a.within_range then 'Present' else 'Absent' end as status,
  a.clock_in_time, a.clock_out_time
from employees e
left join attendance a on a.employee_id = e.id and a.attendance_date = current_date
where e.plant_id = (select id from plants where name = 'Site Ka Naam')
and e.is_active = true
order by e.name;
```

**Kis-kis ki clock-out abhi tak missing hai (aaj ke liye)**
```sql
select e.name, p.name as site, a.clock_in_time
from attendance a
join employees e on e.id = a.employee_id
join plants p on p.id = a.plant_id
where a.attendance_date = current_date
and a.clock_out_time is null;
```

**Sabse zyada "flagged" (review-worthy) entries kis employee ki hain**
```sql
select e.name, count(*) as flagged_count
from attendance a join employees e on e.id = a.employee_id
where a.status = 'flagged'
group by e.name
order by flagged_count desc;
```

---

## Bulk Operations (saavdhani se use karna)

**Sabka device-lock ek saath reset karna** (jaise naya OAuth client ya naya domain migrate karne ke baad)
```sql
update employees set device_id = null, device_locked = false, device_fingerprint = null;
```

**Sabhi sites ka radius ek saath badalna**
```sql
update plants set radius_meters = 400;
```

**Sabhi flagged entries ek saath "OK" karna** (sirf tab jab pakka ho sab genuine the)
```sql
update attendance set status = 'ok', device_mismatch_flag = false where status = 'flagged';
```

**Kisi poori date range ki saari attendance delete karna** (test data cleanup, bahut careful)
```sql
delete from attendance where attendance_date between 'START-DATE' and 'END-DATE';
```
