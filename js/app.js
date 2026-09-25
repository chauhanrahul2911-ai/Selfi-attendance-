// ============================================
// SELFIE ATTENDANCE — APP LOGIC
// ============================================

const supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);

const $ = (id) => document.getElementById(id);

let currentUser = null;      // supabase auth user
let currentEmployee = null;  // row from employees table (with joined plants)
let currentPlant = null;     // row from plants table
let mediaStream = null;
let capturedBlob = null;
let lastLocation = null;     // {lat, lng, accuracy}
let lastDistance = null;
let deviceMismatch = false;
let todayAttendance = null;  // existing attendance row for today, if any

// ---------- DATE (India-local, regardless of device timezone) ----------
function getTodayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ---------- DEVICE ID + FINGERPRINT ----------
function readStoredDeviceId() {
  return localStorage.getItem("attendance_device_id");
}
function writeDeviceId(id) {
  localStorage.setItem("attendance_device_id", id);
  return id;
}
function ensureDeviceId() {
  return readStoredDeviceId() || writeDeviceId(crypto.randomUUID());
}
// A soft fingerprint of the physical device/browser (survives clearing site
// data / history, since it's derived from hardware+browser traits, not
// stored state). Used as a fallback so clearing local storage doesn't turn
// into a false "new device" flag on the same phone.
function getDeviceFingerprint() {
  const parts = [
    navigator.userAgent || "",
    (screen.width || 0) + "x" + (screen.height || 0),
    Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    navigator.language || "",
    navigator.hardwareConcurrency || ""
  ].join("|");
  let hash = 0;
  for (let i = 0; i < parts.length; i++) {
    hash = (hash * 31 + parts.charCodeAt(i)) | 0;
  }
  return "fp_" + Math.abs(hash);
}

// ---------- DISTANCE ----------
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function formatDistance(m) {
  if (m < 1000) return Math.round(m) + " m";
  return (m / 1000).toFixed(2) + " km";
}

function drawRadar(distance, radius, inRange) {
  const size = 200;
  const cx = size / 2, cy = size / 2;
  const maxR = 82;
  const scaleCap = Math.max(radius * 2.2, distance * 1.15, radius + 1);
  const px = (r) => (r / scaleCap) * maxR;
  const allowedPx = px(radius);
  const distPx = Math.min(px(distance), maxR);
  const angle = 0.9;
  const ux = cx + distPx * Math.cos(angle);
  const uy = cy + distPx * Math.sin(angle);
  const dotColor = inRange ? "#2E7D32" : "#B3261E";
  return `
  <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${maxR}" fill="none" stroke="#DAD5C8" stroke-width="1"/>
    <circle cx="${cx}" cy="${cy}" r="${allowedPx}" fill="rgba(201,130,11,0.10)" stroke="#C9820B" stroke-width="1.5" stroke-dasharray="4 3"/>
    <circle cx="${cx}" cy="${cy}" r="4" fill="#1C2541"/>
    <line x1="${cx}" y1="${cy}" x2="${ux}" y2="${uy}" stroke="${dotColor}" stroke-width="1.2" stroke-dasharray="2 2"/>
    <circle cx="${ux}" cy="${uy}" r="6" fill="${dotColor}"/>
  </svg>`;
}

function getPosition() {
  if (!navigator.geolocation) {
    return Promise.reject(new Error("Is browser mein location support nahi hai."));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      (err) => {
        if (err.code === err.TIMEOUT) {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve(pos.coords),
            (err2) => reject(err2),
            { enableHighAccuracy: false, timeout: 30000, maximumAge: 60000 }
          );
        } else {
          reject(err);
        }
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });
}

// ============================================
// LANDING / MODE ROUTING
// ============================================
function hideAllSections() {
  $("landingSection").style.display = "none";
  $("employeeSection").style.display = "none";
  $("viewerSection").style.display = "none";
}

$("modeEmployeeBtn").addEventListener("click", () => enterMode("employee"));
$("modeViewerBtn").addEventListener("click", () => enterMode("viewer"));

document.querySelectorAll(".btn-back").forEach((b) =>
  b.addEventListener("click", () => {
    stopCamera();
    sessionStorage.removeItem("attendance_mode");
    hideAllSections();
    $("landingSection").style.display = "block";
  })
);

document.querySelectorAll(".btn-signout").forEach((b) =>
  b.addEventListener("click", async () => {
    stopCamera();
    sessionStorage.removeItem("attendance_mode");
    await supabaseClient.auth.signOut();
    window.location.reload();
  })
);

async function enterMode(mode) {
  sessionStorage.setItem("attendance_mode", mode);
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    currentUser = session.user;
    await routeToMode(mode);
  } else {
    $("landingStatus").textContent = "Redirecting to Google...";
    await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href.split("#")[0] }
    });
  }
}

async function loadEmployeeRecord() {
  if (currentEmployee) return;
  const email = (currentUser.email || "").trim().toLowerCase();
  const { data: emp, error } = await supabaseClient
    .from("employees")
    .select("*, plants(*)")
    .ilike("email", email)
    .eq("is_active", true)
    .maybeSingle();

  if (emp) {
    currentEmployee = emp;
    currentPlant = emp.plants;
  }
}

async function routeToMode(mode) {
  await loadEmployeeRecord();
  hideAllSections();

  if (mode === "viewer") {
    await loadViewer();
    return;
  }

  // employee mode
  $("employeeSection").style.display = "block";

  if (!currentEmployee) {
    $("notRegistered").style.display = "block";
    $("empName").textContent = currentUser.email;
    $("empPlant").textContent = "Not registered";
    $("clockInFlow").style.display = "none";
    return;
  }

  $("notRegistered").style.display = "none";
  $("empName").textContent = currentEmployee.name;
  $("empPlant").textContent = currentPlant ? currentPlant.name : "No plant assigned";

  await checkDeviceBinding();
  await checkTodayAttendance();
  await loadHistory();
}

async function initAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const savedMode = sessionStorage.getItem("attendance_mode");
  if (session && savedMode) {
    currentUser = session.user;
    await routeToMode(savedMode);
  } else {
    hideAllSections();
    $("landingSection").style.display = "block";
  }
}

supabaseClient.auth.onAuthStateChange((_event, session) => {
  if (session && !currentUser) {
    currentUser = session.user;
    const savedMode = sessionStorage.getItem("attendance_mode") || "employee";
    routeToMode(savedMode);
  }
});

// ============================================
// DEVICE BINDING (with fingerprint fallback)
// ============================================
async function checkDeviceBinding() {
  const storedId = readStoredDeviceId();
  const fingerprint = getDeviceFingerprint();
  $("deviceWarning").style.display = "none";
  deviceMismatch = false;

  if (!currentEmployee.device_id) {
    const myId = ensureDeviceId();
    await supabaseClient
      .from("employees")
      .update({ device_id: myId, device_fingerprint: fingerprint, device_locked: true })
      .eq("id", currentEmployee.id);
    currentEmployee.device_id = myId;
    currentEmployee.device_fingerprint = fingerprint;
    return;
  }

  if (storedId && storedId === currentEmployee.device_id) {
    return; // exact match, all good
  }

  // Local storage id missing or different — before flagging, check if this
  // is still the same physical device (site data / history was cleared).
  if (fingerprint && fingerprint === currentEmployee.device_fingerprint) {
    const myId = ensureDeviceId();
    if (myId !== currentEmployee.device_id) {
      await supabaseClient
        .from("employees")
        .update({ device_id: myId })
        .eq("id", currentEmployee.id);
      currentEmployee.device_id = myId;
    }
    return; // same device, silently re-bound
  }

  // Genuinely a different device.
  ensureDeviceId();
  deviceMismatch = true;
  $("deviceWarning").style.display = "block";
}

// ============================================
// ONE CLOCK-IN PER DAY
// ============================================
async function checkTodayAttendance() {
  const today = getTodayIST();
  const { data } = await supabaseClient
    .from("attendance")
    .select("*")
    .eq("employee_id", currentEmployee.id)
    .eq("attendance_date", today)
    .maybeSingle();

  todayAttendance = data || null;

  if (todayAttendance) {
    $("clockInFlow").style.display = "none";
    $("alreadyMarked").style.display = "block";
    $("alreadyMarkedTime").textContent = new Date(
      todayAttendance.clock_in_time
    ).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    const statusLabel =
      todayAttendance.status === "ok" ? "(OK)" : "(Review ke liye flag hui)";
    $("alreadyMarkedStatus").textContent = statusLabel;
  } else {
    $("alreadyMarked").style.display = "none";
    $("clockInFlow").style.display = "block";
  }
}

// ============================================
// CAMERA
// ============================================
$("startCameraBtn").addEventListener("click", startCamera);
$("retakeBtn").addEventListener("click", retake);
$("captureBtn").addEventListener("click", captureSelfie);
$("submitBtn").addEventListener("click", submitAttendance);

async function startCamera() {
  $("captureStatus").textContent = "Camera khol rahe hain...";
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 } },
      audio: false
    });
    const video = $("video");
    video.srcObject = mediaStream;
    video.style.display = "block";
    $("selfiePreview").style.display = "none";
    $("startCameraBtn").style.display = "none";
    $("captureBtn").style.display = "block";
    $("captureStatus").textContent = "";
  } catch (e) {
    if (e.name === "NotAllowedError") {
      $("captureStatus").textContent =
        "Camera block hai. Address bar ke lock/info icon par tap karke Site Settings mein Camera ko 'Allow' karo, phir page reload karo.";
    } else if (e.name === "NotFoundError") {
      $("captureStatus").textContent = "Is device mein camera nahi mila.";
    } else {
      $("captureStatus").textContent =
        "Camera access nahi mila: " + (e.message || "unknown error");
    }
  }
}

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

function retake() {
  capturedBlob = null;
  lastLocation = null;
  lastDistance = null;
  $("selfiePreview").style.display = "none";
  $("result").style.display = "none";
  $("radarBox").style.display = "none";
  $("submitBtn").style.display = "none";
  $("retakeBtn").style.display = "none";
  $("captureStatus").textContent = "";
  startCamera();
}

async function captureSelfie() {
  if (todayAttendance) return; // safety guard

  const video = $("video");
  const canvas = $("canvas");

  const scale = Math.min(1, 480 / video.videoWidth);
  canvas.width = video.videoWidth * scale;
  canvas.height = video.videoHeight * scale;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  canvas.toBlob(
    (blob) => {
      capturedBlob = blob;
      $("selfiePreview").src = URL.createObjectURL(blob);
      $("selfiePreview").style.display = "block";
      $("video").style.display = "none";
    },
    "image/jpeg",
    0.6
  );

  stopCamera();
  $("captureBtn").style.display = "none";
  $("retakeBtn").style.display = "block";
  $("captureStatus").textContent = "Location check ho rahi hai...";

  if (!currentPlant || currentPlant.latitude == null) {
    $("captureStatus").textContent =
      "Is plant ki location abhi set nahi hai. Admin se contact karein.";
    return;
  }

  try {
    const coords = await getPosition();
    lastLocation = {
      lat: coords.latitude,
      lng: coords.longitude,
      accuracy: coords.accuracy
    };
    const distance = haversineDistance(
      currentPlant.latitude,
      currentPlant.longitude,
      coords.latitude,
      coords.longitude
    );
    lastDistance = distance;
    const inRange = distance <= currentPlant.radius_meters;

    $("captureStatus").textContent = "";
    $("result").style.display = "block";
    $("distanceVal").textContent = formatDistance(distance);
    $("verdictVal").textContent = inRange ? "Plant range ke andar" : "Plant range se bahar";
    $("verdictVal").className = "verdict " + (inRange ? "in" : "out");

    $("radarBox").style.display = "flex";
    $("radarBox").innerHTML = drawRadar(distance, currentPlant.radius_meters, inRange);

    $("submitBtn").style.display = "block";
  } catch (e) {
    $("captureStatus").textContent =
      "Location nahi mil payi: " + (e.message || "permission denied. Location allow karein.");
  }
}

// ============================================
// SUBMIT ATTENDANCE
// ============================================
async function submitAttendance() {
  if (!capturedBlob || !lastLocation || todayAttendance) return;
  $("submitBtn").disabled = true;
  $("captureStatus").textContent = "Attendance submit ho rahi hai...";

  try {
    const fileName = `${currentEmployee.id}/${Date.now()}.jpg`;
    const { error: uploadError } = await supabaseClient.storage
      .from(SELFIE_BUCKET)
      .upload(fileName, capturedBlob, { contentType: "image/jpeg" });

    if (uploadError) throw uploadError;

    const inRange = lastDistance <= currentPlant.radius_meters;
    const lowAccuracy = lastLocation.accuracy > 50;
    const status = deviceMismatch || lowAccuracy || !inRange ? "flagged" : "ok";

    const { error: insertError } = await supabaseClient.from("attendance").insert({
      employee_id: currentEmployee.id,
      plant_id: currentPlant.id,
      attendance_date: getTodayIST(),
      latitude: lastLocation.lat,
      longitude: lastLocation.lng,
      gps_accuracy: lastLocation.accuracy,
      distance_meters: lastDistance,
      within_range: inRange,
      selfie_url: fileName,
      device_id: ensureDeviceId(),
      device_mismatch_flag: deviceMismatch,
      status
    });

    if (insertError) throw insertError;

    $("captureStatus").textContent = "";
    $("result").style.display = "none";
    $("radarBox").style.display = "none";
    $("selfiePreview").style.display = "none";
    $("submitBtn").style.display = "none";
    $("retakeBtn").style.display = "none";
    $("startCameraBtn").style.display = "block";
    alert("Attendance mark ho gayi ✔");
    await checkTodayAttendance();
    await loadHistory();
  } catch (e) {
    if (e.code === "23505") {
      // Unique constraint caught a race (e.g. double tap) — not a real error.
      $("captureStatus").textContent = "Aaj already clock-in ho chuki hai.";
      await checkTodayAttendance();
    } else {
      $("captureStatus").textContent = "Submit fail hua: " + (e.message || e);
    }
  } finally {
    $("submitBtn").disabled = false;
  }
}

// ============================================
// EMPLOYEE HISTORY
// ============================================
async function loadHistory() {
  const wrap = $("historyWrap");
  const { data, error } = await supabaseClient
    .from("attendance")
    .select("*")
    .eq("employee_id", currentEmployee.id)
    .order("clock_in_time", { ascending: false })
    .limit(10);

  if (error || !data || data.length === 0) {
    wrap.innerHTML = '<div class="empty">Abhi tak koi attendance nahi hai.</div>';
    return;
  }

  const rows = data
    .map((r) => {
      const tagClass = r.status === "ok" ? "in" : r.status === "flagged" ? "flag" : "out";
      const label = r.status === "ok" ? "OK" : r.status === "flagged" ? "Flagged" : r.status;
      return `
      <tr>
        <td>${new Date(r.clock_in_time).toLocaleDateString("en-IN")}</td>
        <td>${new Date(r.clock_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</td>
        <td>${formatDistance(r.distance_meters)}</td>
        <td><span class="tag ${tagClass}">${label}</span></td>
      </tr>`;
    })
    .join("");

  wrap.innerHTML = `
    <table>
      <thead><tr><th>Date</th><th>Time</th><th>Distance</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ============================================
// VIEWER DASHBOARD
// ============================================
async function loadViewer() {
  $("viewerSection").style.display = "block";
  $("viewerDenied").style.display = "none";
  $("viewerContent").style.display = "none";

  const email = (currentUser.email || "").trim().toLowerCase();
  const { data: blocked } = await supabaseClient
    .from("blocked_viewers")
    .select("email")
    .ilike("email", email)
    .maybeSingle();

  if (blocked) {
    $("viewerDenied").textContent = "Aapko viewer access se block kar diya gaya hai.";
    $("viewerDenied").style.display = "block";
    return;
  }

  $("viewerContent").style.display = "block";

  if (!$("dateFilter").value) {
    $("dateFilter").value = getTodayIST();
  }
  await renderViewerData($("dateFilter").value);
}

$("dateFilter").addEventListener("change", (e) => renderViewerData(e.target.value));

async function renderViewerData(dateStr) {
  const sitesWrap = $("sitesWrap");
  sitesWrap.innerHTML = '<div class="empty">Loading...</div>';

  const [plantsRes, employeesRes, attendanceRes] = await Promise.all([
    supabaseClient.from("plants").select("*").order("name"),
    supabaseClient.from("employees").select("*").eq("is_active", true).order("sort_order").order("name"),
    supabaseClient.from("attendance").select("*").eq("attendance_date", dateStr)
  ]);

  const plants = plantsRes.data || [];
  const employees = employeesRes.data || [];
  const attendanceRows = attendanceRes.data || [];

  const attByEmployee = {};
  attendanceRows.forEach((r) => { attByEmployee[r.employee_id] = r; });

  let totalPresent = 0, totalAbsent = 0;
  sitesWrap.innerHTML = "";

  plants.forEach((plant) => {
    const plantEmployees = employees.filter((e) => e.plant_id === plant.id);
    let present = 0, absent = 0;

    const rowsHtml = plantEmployees
      .map((emp) => {
        const rec = attByEmployee[emp.id];
        const isPresent = !!(rec && rec.within_range === true);
        if (isPresent) present++; else absent++;

        const timeStr = rec
          ? new Date(rec.clock_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
          : "—";
        const noteStr = rec && !rec.within_range ? " · range se bahar" : "";

        const mapBtn = rec
          ? `<button class="icon-btn" data-lat="${rec.latitude}" data-lng="${rec.longitude}" title="Location dekhein">🗺️</button>`
          : `<button class="icon-btn" disabled>—</button>`;
        const viewBtn = rec
          ? `<button class="photo-btn" data-selfie="${rec.selfie_url}" data-name="${emp.name}" data-time="${timeStr}" data-dist="${rec.distance_meters ? Math.round(rec.distance_meters) : ""}" data-lat="${rec.latitude}" data-lng="${rec.longitude}">📷 View</button>`
          : `<button class="photo-btn" disabled>—</button>`;

        return `
        <div class="employee-row">
          <div><div class="empname">${emp.name}</div><div class="empmeta">${timeStr}${noteStr}</div></div>
          <div class="status-badge ${isPresent ? "green" : "red"}" title="${isPresent ? "Present" : "Absent"}">${isPresent ? "P" : "A"}</div>
          <div class="row-actions">${mapBtn}${viewBtn}</div>
        </div>`;
      })
      .join("");

    totalPresent += present;
    totalAbsent += absent;

    const badge =
      absent === 0 && plantEmployees.length > 0
        ? '<span class="badge">All Present</span>'
        : present === 0
        ? '<span class="badge bad">All Absent</span>'
        : '<span class="badge warn">Partial</span>';

    const card = document.createElement("div");
    card.className = "site-card";
    card.innerHTML = `
      <div class="sitehead">
        <div><div class="site-title">${plant.name}</div><div class="location">${plantEmployees.length} employees</div></div>
        ${badge}
      </div>
      ${rowsHtml || '<div class="empty">Koi employee assign nahi hai.</div>'}
    `;
    sitesWrap.appendChild(card);
  });

  $("statsRow").innerHTML = `
    <div class="stat"><div class="label">Sites</div><div class="num blue">${plants.length}</div></div>
    <div class="stat"><div class="label">Present</div><div class="num green">${totalPresent}</div></div>
    <div class="stat"><div class="label">Absent</div><div class="num red">${totalAbsent}</div></div>
  `;

  document.querySelectorAll(".photo-btn[data-selfie]").forEach((btn) => {
    btn.addEventListener("click", () =>
      openSelfieModal(
        btn.dataset.selfie,
        btn.dataset.name,
        btn.dataset.time,
        btn.dataset.dist,
        btn.dataset.lat,
        btn.dataset.lng
      )
    );
  });

  document.querySelectorAll(".icon-btn[data-lat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.open(`https://www.google.com/maps?q=${btn.dataset.lat},${btn.dataset.lng}`, "_blank");
    });
  });
}

async function openSelfieModal(path, name, time, dist, lat, lng) {
  $("modalMeta").textContent = "Loading...";
  $("modalImg").src = "";
  if (lat && lng) {
    $("modalMapLink").href = `https://www.google.com/maps?q=${lat},${lng}`;
    $("modalMapLink").style.display = "block";
  } else {
    $("modalMapLink").style.display = "none";
  }
  $("selfieModal").style.display = "flex";

  const { data, error } = await supabaseClient.storage.from(SELFIE_BUCKET).createSignedUrl(path, 60);
  if (error || !data) {
    $("modalMeta").textContent = "Selfie load nahi ho payi.";
    return;
  }
  $("modalImg").src = data.signedUrl;
  $("modalMeta").textContent = `${name} · ${time}${dist ? " · " + dist + "m" : ""}`;
}

$("modalCloseBtn").addEventListener("click", () => {
  $("selfieModal").style.display = "none";
});

// ============================================
// INIT
// ============================================
initAuth();
