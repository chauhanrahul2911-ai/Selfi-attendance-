# Selfie Attendance

Google login → live camera se selfie → GPS location → assigned plant se distance calculate → Supabase mein save.

## Files

```
selfie-attendance/
├── index.html
├── css/styles.css
├── js/config.js        ← yahan apni Supabase keys daalni hain
├── js/app.js
├── supabase-schema.sql ← Supabase mein ek baar run karna hai
└── README.md
```

## Setup — step by step

### 1. Supabase project banao
[supabase.com](https://supabase.com) par free account bana kar naya project banao.

### 2. Database schema run karo
Supabase Dashboard → **SQL Editor** → `supabase-schema.sql` ka pura content copy-paste karke **Run** dabao.
Isse `plants`, `employees`, `attendance` tables ban jayenge, 5 plants insert ho jayenge, aur employees bhi (dummy emails ke saath, sirf Rahul ka email real hai — testing ke liye).

### 3. Storage bucket banao
Dashboard → **Storage** → **New bucket** → naam exactly `attendance-selfies`, **Private** rakhna (public mat karna). Schema file ke andar jo storage policies hain wo already SQL Editor se run ho chuki hongi (step 2 mein).

### 4. Google OAuth setup
1. [Google Cloud Console](https://console.cloud.google.com) → naya project → **APIs & Services → Credentials**
2. **Create Credentials → OAuth Client ID** → type: **Web application**
3. **Authorized redirect URI** mein daalo:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
   (`<your-project-ref>` Supabase project settings mein milega)
4. Client ID + Client Secret copy karo
5. Supabase Dashboard → **Authentication → Providers → Google** → dono paste karo → Save

### 5. Redirect URL Supabase mein whitelist karo
Supabase Dashboard → **Authentication → URL Configuration**:
- **Site URL**: `https://<your-github-username>.github.io/<repo-name>/`
- **Redirect URLs** mein bhi wahi URL add karo

(GitHub Pages live karne ke baad hi exact URL milega — step 7 ke baad yahan aa kar update kar dena.)

### 6. `js/config.js` fill karo
Supabase Dashboard → **Settings → API** se copy karo:
```js
const SUPABASE_CONFIG = {
  url: "https://xxxxxxxx.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIs...."
};
```

### 7. GitHub Pages par deploy karo
1. Naya GitHub repo banao, is poore folder ka content push karo
2. Repo → **Settings → Pages** → Source: `main` branch, root folder → Save
3. Kuch minute mein `https://<username>.github.io/<repo-name>/` par live ho jayega
4. Ab step 5 mein wapas jao aur Supabase mein yehi exact URL confirm kar do

### 8. Test karo
Rahul ke real Gmail (`chauhanrahul2850@gmail.com`) se login karo — usse "Office" plant assign hai. Camera permission allow karo, location permission allow karo, selfie lo, submit karo. Supabase Dashboard → **Table Editor → attendance** mein record dikhna chahiye.

## Baaki employees add karna

Abhi 9 employees ke email **dummy** hain (jaise `sagar.chauhan.dummy1@gmail.com`) — inse login nahi ho payega kyunki yeh real Gmail accounts nahi hain. Jab real Gmail mil jaye, Supabase **SQL Editor** mein:

```sql
update employees set email = 'real.email@gmail.com' where name = 'Sagar Chauhan';
```

## Isme kya included hai

- **Google Sign-In** (Supabase Auth) — sirf registered employees hi login kar sakte hain
- **Live camera selfie** — koi gallery/file-upload option nahi hai, seedha camera se capture
- **GPS distance check** — employee ke assigned plant se live distance nikal kar radius ke andar/bahar dikhata hai
- **Device binding** — pehli login jis phone/browser se hogi, wahi us employee ka locked device ban jata hai. Doosre device se login hone par attendance **block nahi hoti** par `flagged` status ke saath save hoti hai (History table mein "Flagged" dikhega)
- **Low-accuracy GPS flag** — agar location signal weak/suspicious ho (accuracy > 50m) to bhi flag ho jata hai
- **Selfie compression** — photo 480px width + 60% quality par save hoti hai (~30-60 KB), Supabase free 1GB storage saalon chalega
- **Attendance history** — har employee apni last 10 entries dekh sakta hai

## Known limitations (agle phase mein karna hai)

1. **Distance/flag calculation abhi client-side (browser JS) mein hoti hai.** Koi technically-savvy user browser console se values manipulate kar sakta hai. Production ke liye yeh logic ek **Supabase Edge Function** mein move karna chahiye jo server-side verify kare — abhi ke liye testing/MVP ke liye theek hai.
2. **IP-address se location cross-check abhi implement nahi hai** — isme ek external geo-IP API aur Edge Function chahiye hoga.
3. **Mock-GPS app detection** (Android "Allow mock locations" setting) browser se directly detect nahi ho sakta — isके liye website ko native app wrapper (Capacitor) mein convert karna padega.
4. **Admin panel abhi nahi hai** — records dekhne ke liye abhi Supabase Table Editor use karna hoga. Chaho to alag se admin dashboard bhi bana sakte hain.
