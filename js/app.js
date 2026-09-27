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
let attendanceMode = "in";   // "in" | "out" | "done" — which action the camera flow currently performs
let lastAttendanceById = {}; // record id -> attendance row, for the Viewer's selfie modal

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
  const dotColor = inRange ? "#1F8A63" : "#B3261E";
  return `
  <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${maxR}" fill="none" stroke="#E1D8C2" stroke-width="1"/>
    <circle cx="${cx}" cy="${cy}" r="${allowedPx}" fill="rgba(227,161,33,0.12)" stroke="#E3A121" stroke-width="1.5" stroke-dasharray="4 3"/>
    <circle cx="${cx}" cy="${cy}" r="5.5" fill="#fff" stroke="#142B27" stroke-width="2"/>
    <line x1="${cx}" y1="${cy}" x2="${ux}" y2="${uy}" stroke="${dotColor}" stroke-width="1.4" stroke-dasharray="2.5 2.5"/>
    <circle cx="${ux}" cy="${uy}" r="6.5" fill="${dotColor}" stroke="#fff" stroke-width="2"/>
  </svg>`;
}

// Waits for a GOOD GPS fix instead of accepting the first (often coarse,
// network-based) reading. Keeps listening for up to `timeoutMs`, tracking
// the best (lowest-accuracy) reading seen, and finishes early the moment
// accuracy drops to `desiredAccuracy` meters or better.
function getBestPosition(timeoutMs = 15000, desiredAccuracy = 30) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Is browser mein location support nahi hai."));
      return;
    }
    let best = null;
    let watchId = null;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (best) resolve(best);
      else reject(new Error("Location nahi mil payi. Permission allow hai aur GPS on hai, confirm karein."));
    };

    const timer = setTimeout(finish, timeoutMs);

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || pos.coords.accuracy < best.accuracy) {
          best = pos.coords;
        }
        if (pos.coords.accuracy <= desiredAccuracy) {
          clearTimeout(timer);
          finish();
        }
      },
      (err) => {
        if (!best) {
          clearTimeout(timer);
          finished = true;
          if (watchId !== null) navigator.geolocation.clearWatch(watchId);
          reject(err);
        }
        // if a reading already exists, ignore later errors and let the
        // timeout resolve with the best reading found so far
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
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
    // Employee mid-flow (camera open) → step back to the choice screen first,
    // not all the way to landing.
    const inEmployeeCameraFlow =
      $("employeeSection").style.display !== "none" &&
      $("clockInFlow").style.display !== "none";

    if (inEmployeeCameraFlow) {
      stopCamera();
      resetCaptureState();
      $("clockInFlow").style.display = "none";
      $("actionChoice").style.display = "flex";
      return;
    }

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
    $("actionChoice").style.display = "none";
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
// CLOCK-IN / CLOCK-OUT CHOICE CARDS
// ============================================
function setFlowLabels(mode) {
  if (mode === "in") {
    $("captureBtn").textContent = "📸 Selfie Le Kar Clock-In Karein";
    $("submitBtn").textContent = "Attendance Submit Karein";
  } else {
    $("captureBtn").textContent = "📸 Selfie Le Kar Clock-Out Karein";
    $("submitBtn").textContent = "Clock-Out Submit Karein";
  }
}

function formatTime(t) {
  return new Date(t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function resetCaptureState() {
  capturedBlob = null;
  lastLocation = null;
  lastDistance = null;
  $("video").style.display = "none";
  $("selfiePreview").style.display = "none";
  $("result").style.display = "none";
  $("radarBox").style.display = "none";
  $("locationChecking").style.display = "none";
  $("submitBtn").style.display = "none";
  $("retakeBtn").style.display = "none";
  $("captureBtn").style.display = "none";
  $("startCameraBtn").style.display = "block";
  $("captureStatus").textContent = "";
}

function renderActionChoice() {
  const inDone = !!todayAttendance;
  const outDone = !!(todayAttendance && todayAttendance.clock_out_time);

  $("clockInChoiceBtn").disabled = inDone;
  $("clockInSub").textContent = inDone
    ? `✓ Done — ${formatTime(todayAttendance.clock_in_time)}`
    : "Din shuru karein";

  $("clockOutChoiceBtn").disabled = !inDone || outDone;
  if (!inDone) {
    $("clockOutSub").textContent = "Pehle clock-in karein";
  } else if (outDone) {
    const hoursDecimal =
      (new Date(todayAttendance.clock_out_time) - new Date(todayAttendance.clock_in_time)) / 3600000;
    const h = Math.floor(hoursDecimal);
    const m = Math.round((hoursDecimal - h) * 60);
    $("clockOutSub").textContent = `✓ Done — ${formatTime(todayAttendance.clock_out_time)} (${h}h ${m}m)`;
  } else {
    $("clockOutSub").textContent = "Din khatam karein";
  }
}

async function checkTodayAttendance() {
  const today = getTodayIST();
  const { data } = await supabaseClient
    .from("attendance")
    .select("*")
    .eq("employee_id", currentEmployee.id)
    .eq("attendance_date", today)
    .maybeSingle();

  todayAttendance = data || null;
  attendanceMode = !todayAttendance ? "in" : todayAttendance.clock_out_time ? "done" : "out";

  resetCaptureState();
  $("clockInFlow").style.display = "none";
  $("actionChoice").style.display = "flex";
  renderActionChoice();
}

$("clockInChoiceBtn").addEventListener("click", () => {
  if ($("clockInChoiceBtn").disabled) return;
  attendanceMode = "in";
  setFlowLabels("in");
  $("actionChoice").style.display = "none";
  $("clockInFlow").style.display = "block";
});

$("clockOutChoiceBtn").addEventListener("click", () => {
  if ($("clockOutChoiceBtn").disabled) return;
  attendanceMode = "out";
  setFlowLabels("out");
  $("actionChoice").style.display = "none";
  $("clockInFlow").style.display = "block";
});

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
  resetCaptureState();
  startCamera();
}

async function captureSelfie() {
  if (attendanceMode === "done") return; // safety guard

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
  $("captureStatus").textContent = "";

  if (!currentPlant || currentPlant.latitude == null) {
    $("captureStatus").textContent =
      "Is plant ki location abhi set nahi hai. Admin se contact karein.";
    return;
  }

  const countdownEl = $("locationCountdown");
  let secondsLeft = 15;
  countdownEl.textContent = secondsLeft;
  $("locationChecking").style.display = "flex";
  const countdownTimer = setInterval(() => {
    secondsLeft = Math.max(0, secondsLeft - 1);
    countdownEl.textContent = secondsLeft;
  }, 1000);

  try {
    const coords = await getBestPosition();
    clearInterval(countdownTimer);
    $("locationChecking").style.display = "none";

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

    $("captureStatus").textContent =
      coords.accuracy > 100
        ? "GPS signal thoda weak mila — submit ho jayega, par review ke liye flag ho sakta hai."
        : "";
    $("result").style.display = "block";
    $("distanceVal").textContent = formatDistance(distance);
    $("verdictVal").textContent = inRange ? "Plant range ke andar" : "Plant range se bahar";
    $("verdictVal").className = "verdict " + (inRange ? "in" : "out");

    $("radarBox").style.display = "flex";
    $("radarBox").innerHTML = drawRadar(distance, currentPlant.radius_meters, inRange);

    $("submitBtn").style.display = "block";
  } catch (e) {
    clearInterval(countdownTimer);
    $("locationChecking").style.display = "none";
    $("captureStatus").textContent =
      "Location nahi mil payi: " + (e.message || "permission denied. Location allow karein.");
  }
}

// ============================================
// SUBMIT ATTENDANCE
// ============================================
async function submitAttendance() {
  if (!capturedBlob || !lastLocation || attendanceMode === "done") return;
  $("submitBtn").disabled = true;
  $("captureStatus").textContent =
    attendanceMode === "in" ? "Attendance submit ho rahi hai..." : "Clock-out submit ho raha hai...";

  try {
    const fileName = `${currentEmployee.id}/${Date.now()}.jpg`;
    const { error: uploadError } = await supabaseClient.storage
      .from(SELFIE_BUCKET)
      .upload(fileName, capturedBlob, { contentType: "image/jpeg" });

    if (uploadError) throw uploadError;

    const inRange = lastDistance <= currentPlant.radius_meters;
    const lowAccuracy = lastLocation.accuracy > 50;
    const rowStatus = deviceMismatch || lowAccuracy || !inRange ? "flagged" : "ok";

    if (attendanceMode === "in") {
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
        status: rowStatus
      });
      if (insertError) throw insertError;
    } else {
      const { error: updateError } = await supabaseClient
        .from("attendance")
        .update({
          clock_out_time: new Date().toISOString(),
          clock_out_latitude: lastLocation.lat,
          clock_out_longitude: lastLocation.lng,
          clock_out_gps_accuracy: lastLocation.accuracy,
          clock_out_distance_meters: lastDistance,
          clock_out_within_range: inRange,
          clock_out_selfie_url: fileName,
          clock_out_device_mismatch_flag: deviceMismatch,
          clock_out_status: rowStatus
        })
        .eq("id", todayAttendance.id);
      if (updateError) throw updateError;
    }

    alert(attendanceMode === "in" ? "Attendance mark ho gayi ✔" : "Clock-out ho gaya ✔");
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
      const outStr = r.clock_out_time ? formatTime(r.clock_out_time) : "—";
      return `
      <tr>
        <td>${new Date(r.clock_in_time).toLocaleDateString("en-IN")}</td>
        <td>${formatTime(r.clock_in_time)}</td>
        <td>${outStr}</td>
        <td>${formatDistance(r.distance_meters)}</td>
        <td><span class="tag ${tagClass}">${label}</span></td>
      </tr>`;
    })
    .join("");

  wrap.innerHTML = `
    <table>
      <thead><tr><th>Date</th><th>In</th><th>Out</th><th>Distance</th><th>Status</th></tr></thead>
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
    supabaseClient.from("plants").select("*").eq("hidden_from_viewer", false).order("name"),
    supabaseClient.from("employees").select("*").eq("is_active", true).order("sort_order").order("name"),
    supabaseClient.from("attendance").select("*").eq("attendance_date", dateStr)
  ]);

  const plants = plantsRes.data || [];
  const employees = employeesRes.data || [];
  const attendanceRows = attendanceRes.data || [];

  const attByEmployee = {};
  attendanceRows.forEach((r) => { attByEmployee[r.employee_id] = r; });
  lastAttendanceById = {};

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

        const inStr = rec ? formatTime(rec.clock_in_time) : "—";
        const outStr = rec && rec.clock_out_time ? formatTime(rec.clock_out_time) : "—";
        let totalStr = "0h 0m";
        if (rec && rec.clock_out_time) {
          const hoursDecimal = (new Date(rec.clock_out_time) - new Date(rec.clock_in_time)) / 3600000;
          const h = Math.floor(hoursDecimal);
          const m = Math.round((hoursDecimal - h) * 60);
          totalStr = `${h}h ${m}m`;
        }
        const noteStr = rec && !rec.within_range ? " (range se bahar)" : "";

        if (rec) lastAttendanceById[rec.id] = rec;
        const viewBtn = rec
          ? `<button class="photo-btn" data-id="${rec.id}" data-name="${emp.name}">📷 View</button>`
          : `<button class="photo-btn" disabled>—</button>`;

        return `
        <div class="employee-row">
          <div>
            <div class="empname">${emp.name}</div>
            <div class="empmeta">In: ${inStr}${noteStr}<br>Out: ${outStr}<br>Total: ${totalStr}</div>
          </div>
          <div class="status ${isPresent ? "green" : "red"}">● ${isPresent ? "Present" : "Absent"}</div>
          ${viewBtn}
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

  document.querySelectorAll(".photo-btn[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rec = lastAttendanceById[btn.dataset.id];
      if (rec) openSelfieModal(rec, btn.dataset.name);
    });
  });
}

function mapEmbedUrl(lat, lng) {
  return `https://maps.google.com/maps?q=${lat},${lng}&z=17&t=k&output=embed`;
}

async function openSelfieModal(rec, name) {
  $("selfieModal").style.display = "flex";

  // --- Clock-in section (always present when the row is clickable) ---
  $("modalInMeta").textContent = "Loading...";
  $("modalInImg").src = "";
  const inTime = formatTime(rec.clock_in_time);
  const inDist = rec.distance_meters ? Math.round(rec.distance_meters) + "m" : "";
  if (rec.latitude && rec.longitude) {
    $("modalInMapFrame").src = mapEmbedUrl(rec.latitude, rec.longitude);
    $("modalInMapFrame").style.display = "block";
  } else {
    $("modalInMapFrame").src = "";
    $("modalInMapFrame").style.display = "none";
  }
  supabaseClient.storage.from(SELFIE_BUCKET).createSignedUrl(rec.selfie_url, 60).then(({ data, error }) => {
    if (error || !data) {
      $("modalInMeta").textContent = "Selfie load nahi ho payi.";
      return;
    }
    $("modalInImg").src = data.signedUrl;
    $("modalInMeta").textContent = `${name} · In: ${inTime}${inDist ? " · " + inDist : ""}`;
  });

  // --- Clock-out section (only if it happened) ---
  if (rec.clock_out_time && rec.clock_out_selfie_url) {
    $("modalOutEmpty").style.display = "none";
    $("modalOutImg").style.display = "block";
    $("modalOutMeta").style.display = "block";
    $("modalOutMeta").textContent = "Loading...";
    $("modalOutImg").src = "";
    const outTime = formatTime(rec.clock_out_time);
    const outDist = rec.clock_out_distance_meters ? Math.round(rec.clock_out_distance_meters) + "m" : "";
    if (rec.clock_out_latitude && rec.clock_out_longitude) {
      $("modalOutMapFrame").src = mapEmbedUrl(rec.clock_out_latitude, rec.clock_out_longitude);
      $("modalOutMapFrame").style.display = "block";
    } else {
      $("modalOutMapFrame").src = "";
      $("modalOutMapFrame").style.display = "none";
    }
    supabaseClient.storage.from(SELFIE_BUCKET).createSignedUrl(rec.clock_out_selfie_url, 60).then(({ data, error }) => {
      if (error || !data) {
        $("modalOutMeta").textContent = "Selfie load nahi ho payi.";
        return;
      }
      $("modalOutImg").src = data.signedUrl;
      $("modalOutMeta").textContent = `${name} · Out: ${outTime}${outDist ? " · " + outDist : ""}`;
    });
  } else {
    $("modalOutEmpty").style.display = "block";
    $("modalOutImg").style.display = "none";
    $("modalOutMeta").style.display = "none";
    $("modalOutMapFrame").src = "";
    $("modalOutMapFrame").style.display = "none";
  }
}

$("modalCloseBtn").addEventListener("click", () => {
  $("selfieModal").style.display = "none";
  $("modalInMapFrame").src = "";
  $("modalOutMapFrame").src = "";
});

// ============================================
// INIT
// ============================================
initAuth();
