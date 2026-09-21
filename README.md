# Selfie Attendance

Google login → Employee ya Viewer choose karo → Employee: live camera selfie + GPS distance check + clock-in. Viewer: sabhi sites ka live attendance dashboard.

## Files

```
selfie-attendance/
├── index.html
├── css/styles.css
├── js/config.js        ← yahan apni Supabase keys daalni hain
├── js/app.js
├── supabase-schema.sql ← Supabase mein run karna hai (naye setup ya migration dono ke liye)
└── README.md
```

## Naye setup ke liye (pehli baar)
Purane README wale steps 1–8 same hain (Supabase project, schema run, storage bucket, Google OAuth, config.js, GitHub Pages deploy). `supabase-schema.sql` poori file top-to-bottom run karo — ismein migration section bhi already included hai, dono fresh install aur upgrade ke liye safe hai.

## Agar pehle se chal raha hai (upgrade)
Sirf `supabase-schema.sql` file ka **naya content** (section 9 — "MIGRATION") SQL Editor mein paste karke run kar do. Yeh safe hai, dobara run karne se kuch टूटेगा nahi.

Migration ke baad ek line zaroor check karo:
```sql
update employees set is_admin = true where email = 'chauhanrahul2850@gmail.com';
```
Isse Rahul ko **Viewer dashboard access** mil jata hai. Kisi aur ko bhi viewer banana ho to unka email isi tarah `is_admin = true` kar dena.

## Is update mein kya naya hai

### 1. Ek din mein sirf ek clock-in
Ab agar employee ne aaj already attendance mark kar li hai, to camera/clock-in options hide ho jate hain aur "Aaj already clock-in ho chuki hai — [time]" dikhta hai. Yeh do level par enforce hota hai:
- App khud check karke button hide kar deta hai
- **Database level par bhi lock hai** (unique constraint) — koi bhi tarike se bhi dusri baar insert nahi ho sakta, chahe koi console se try kare

### 2. Device-flag fix (site data clear hone par)
Pehle: agar employee apne phone ka browser history/site-data clear karta tha, to naya "device" detect ho jata tha aur galat flag lagta tha.
Ab: ek **device fingerprint** (phone/browser ki hi characteristics se bana, jo site-data clear hone par bhi nahi badalta) backup ke roop mein check hota hai. Agar fingerprint match kare to same device maana jata hai, dobara silently bind ho jata hai — flag nahi lagta. Sirf **genuinely naya device/phone** hi flag hoga.

*Note: yeh 100% foolproof nahi hai (koi bahut technical user isse bhi bypass kar sakta hai), lekin normal "history clear kiya" wali situation ab sahi se handle hoti hai.*

### 3. Landing screen — Employee ya Viewer
Website khulte hi ab do button dikhte hain: **Employee** (clock-in ke liye) aur **Viewer** (dashboard dekhne ke liye). Dono Google se sign-in maangte hain. Viewer sirf unhi employees ko milta hai jinka `is_admin = true` hai database mein.

### 4. Viewer Dashboard
- Date picker — aaj ke alawa purane din bhi dekh sakte ho
- Har site (plant) ka apna card, real naam ke saath — koi bhi site/employee hardcoded nahi hai, sab database se live aata hai
- **Present** = us din within-range clock-in hua ho
- **Absent** = clock-in hi nahi hua, YA clock-in hua par range se bahar tha (row par "range se bahar" note dikhta hai clarity ke liye)
- **View button** — us employee ki selfie kholta hai (secure signed link, 60 second ke liye valid)
- Sites/Present/Absent ka summary top par

## Site ya employee add karna — ab sirf database se, koi code change nahi

**Naya site add karna:**
```sql
insert into plants (name, latitude, longitude, radius_meters)
values ('Naya Site Ka Naam', 21.xxxxx, 70.xxxxx, 150);
```

**Naya employee add karna:**
```sql
insert into employees (plant_id, name, email)
select id, 'Employee Ka Naam', 'unka.email@gmail.com'
from plants where name = 'Site Ka Naam';
```
(Ismein bhi Google OAuth test-users list mein unka email add karna mat bhoolna, jab tak app "Testing" mode mein hai.)

Bas — koi HTML/JS file edit ya redeploy karne ki zaroorat nahi. App hamesha `plants` aur `employees` table se live data uthata hai.

## Purani limitations (still true)
1. Distance/flag calculation abhi client-side hai — production-grade tamper-proofing ke liye Supabase Edge Function chahiye hoga (agla phase)
2. IP-based location cross-check implement nahi hai
3. Android "mock GPS" developer-setting detection ke liye native app wrapper chahiye hoga, plain website se possible nahi
