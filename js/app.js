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
let attendanceMode = "in";   // "in" | "mid" | "out" | "done" — which punch the camera flow currently performs
let lastAttendanceById = {}; // record id -> attendance row, for the Viewer's selfie modal
let lastPlantsById = {};     // plant id -> plant row, so the modal knows 2 vs 3 punches
let viewerRegion = null;     // region the Viewer picked (e.g. "Jamjodhpur" / "Sarla")

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
    const visible = (id) => $(id).style.display !== "none";

    // One screen back at a time:
    //   camera flow -> punch cards -> landing
    //   viewer dashboard -> region choice -> landing
    if (visible("employeeSection") && visible("clockInFlow")) {
      stopCamera();
      resetCaptureState();
      $("clockInFlow").style.display = "none";
      $("actionChoice").style.display = "flex";
      return;
    }
    if (visible("viewerSection") && visible("viewerContent")) {
      $("viewerContent").style.display = "none";
      $("viewerRegionChoice").style.display = "flex";
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
  await checkTodayAttendance(); // shows this employee's own punch cards directly
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
// ---- Regions (Jamjodhpur / Sarla / ...) come from plants.region in the DB ----
async function fetchRegions(onlyVisible) {
  let q = supabaseClient.from("plants").select("region");
  if (onlyVisible) q = q.eq("hidden_from_viewer", false);
  const { data } = await q;
  const list = [...new Set((data || []).map((p) => p.region || "Jamjodhpur"))].sort();
  return list.length ? list : [""];
}

function renderRegionButtons(container, regions, subText, onPick) {
  container.innerHTML = "";
  regions.forEach((r) => {
    const b = document.createElement("button");
    b.className = "btn-mode";
    b.innerHTML =
      '<span class="mode-icon">📍</span><span class="mode-label"></span><span class="mode-sub"></span>';
    b.querySelector(".mode-label").textContent = r;
    b.querySelector(".mode-sub").textContent = subText;
    b.addEventListener("click", () => onPick(r));
    container.appendChild(b);
  });
}

// ---- Punch model: a plant has 2 punches (in/out) or 3 (in/mid/out) per day ----
const PUNCH_NAME = { in: "clock-in", mid: "dopahar ki hazri", out: "clock-out" };

const LABELS = {
  in: {
    capture: "📸 Selfie Le Kar Clock-In Karein",
    submit: "Attendance Submit Karein",
    busy: "Attendance submit ho rahi hai...",
    ok: "Attendance mark ho gayi ✔"
  },
  mid: {
    capture: "📸 Selfie Le Kar Dopahar Ki Hazri Lagayein",
    submit: "Dopahar Hazri Submit Karein",
    busy: "Dopahar ki hazri submit ho rahi hai...",
    ok: "Dopahar ki hazri lag gayi ✔"
  },
  out: {
    capture: "📸 Selfie Le Kar Clock-Out Karein",
    submit: "Clock-Out Submit Karein",
    busy: "Clock-out submit ho raha hai...",
    ok: "Clock-out ho gaya ✔"
  }
};

const IDLE_TEXT = {
  2: { in: "Din shuru karein", out: "Din khatam karein" },
  3: { in: "Subah — aane par", mid: "Dopahar — beech ki hazri", out: "Shaam — ghar jaate waqt" }
};

const CARD_IDS = {
  in: ["clockInChoiceBtn", "clockInSub"],
  mid: ["midChoiceBtn", "midSub"],
  out: ["clockOutChoiceBtn", "clockOutSub"]
};

function punchesPerDay() {
  return currentPlant && Number(currentPlant.punches_per_day) === 3 ? 3 : 2;
}

function punchSequence() {
  return punchesPerDay() === 3 ? ["in", "mid", "out"] : ["in", "out"];
}

function punchTimeOf(rec, p) {
  if (!rec) return null;
  return p === "in" ? rec.clock_in_time : p === "mid" ? rec.mid_time : rec.clock_out_time;
}

function nextPunch(rec) {
  for (const p of punchSequence()) {
    if (!punchTimeOf(rec, p)) return p;
  }
  return "done";
}

function totalHoursText(rec) {
  if (!rec || !rec.clock_out_time) return null;
  const minutes = Math.round((new Date(rec.clock_out_time) - new Date(rec.clock_in_time)) / 60000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function setFlowLabels(mode) {
  $("captureBtn").textContent = LABELS[mode].capture;
  $("submitBtn").textContent = LABELS[mode].submit;
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
  const seq = punchSequence();
  const idle = IDLE_TEXT[seq.length];
  const next = nextPunch(todayAttendance);

  $("midChoiceBtn").style.display = seq.length === 3 ? "flex" : "none";

  seq.forEach((p, i) => {
    const [btnId, subId] = CARD_IDS[p];
    const t = punchTimeOf(todayAttendance, p);
    $(btnId).disabled = next !== p;

    if (t) {
      let txt = `✓ Done — ${formatTime(t)}`;
      if (p === "out") {
        const total = totalHoursText(todayAttendance);
        if (total) txt += ` (${total})`;
      }
      $(subId).textContent = txt;
    } else if (next === p) {
      $(subId).textContent = idle[p];
    } else {
      $(subId).textContent = `Pehle ${PUNCH_NAME[seq[i - 1]]} karein`;
    }
  });
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
  attendanceMode = nextPunch(todayAttendance);

  resetCaptureState();
  $("clockInFlow").style.display = "none";
  renderActionChoice();
  $("actionChoice").style.display = "flex";
}

function startPunch(p) {
  attendanceMode = p;
  setFlowLabels(p);
  $("actionChoice").style.display = "none";
  $("clockInFlow").style.display = "block";
}

$("clockInChoiceBtn").addEventListener("click", () => {
  if (!$("clockInChoiceBtn").disabled) startPunch("in");
});
$("midChoiceBtn").addEventListener("click", () => {
  if (!$("midChoiceBtn").disabled) startPunch("mid");
});
$("clockOutChoiceBtn").addEventListener("click", () => {
  if (!$("clockOutChoiceBtn").disabled) startPunch("out");
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
  const L = LABELS[attendanceMode];
  $("submitBtn").disabled = true;
  $("captureStatus").textContent = L.busy;

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
      // mid  -> mid_* columns,  out -> clock_out_* columns (same row as clock-in)
      const prefix = attendanceMode === "mid" ? "mid_" : "clock_out_";
      const payload = {};
      payload[prefix + "time"] = new Date().toISOString();
      payload[prefix + "latitude"] = lastLocation.lat;
      payload[prefix + "longitude"] = lastLocation.lng;
      payload[prefix + "gps_accuracy"] = lastLocation.accuracy;
      payload[prefix + "distance_meters"] = lastDistance;
      payload[prefix + "within_range"] = inRange;
      payload[prefix + "selfie_url"] = fileName;
      payload[prefix + "device_mismatch_flag"] = deviceMismatch;
      payload[prefix + "status"] = rowStatus;

      const { error: updateError } = await supabaseClient
        .from("attendance")
        .update(payload)
        .eq("id", todayAttendance.id);
      if (updateError) throw updateError;
    }

    alert(L.ok);
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

  const is3 = punchesPerDay() === 3;

  const rows = data
    .map((r) => {
      const tagClass = r.status === "ok" ? "in" : r.status === "flagged" ? "flag" : "out";
      const label = r.status === "ok" ? "OK" : r.status === "flagged" ? "Flagged" : r.status;
      const midStr = r.mid_time ? formatTime(r.mid_time) : "—";
      const outStr = r.clock_out_time ? formatTime(r.clock_out_time) : "—";
      return `
      <tr>
        <td>${new Date(r.clock_in_time).toLocaleDateString("en-IN")}</td>
        <td>${formatTime(r.clock_in_time)}</td>
        ${is3 ? `<td>${midStr}</td>` : ""}
        <td>${outStr}</td>
        ${is3 ? "" : `<td>${formatDistance(r.distance_meters)}</td>`}
        <td><span class="tag ${tagClass}">${label}</span></td>
      </tr>`;
    })
    .join("");

  wrap.innerHTML = `
    <table>
      <thead><tr><th>Date</th><th>In</th>${is3 ? "<th>Mid</th>" : ""}<th>Out</th>${is3 ? "" : "<th>Distance</th>"}<th>Status</th></tr></thead>
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
  $("viewerRegionChoice").style.display = "none";

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

  const regions = await fetchRegions(true);
  renderRegionButtons($("viewerRegionChoice"), regions, "Attendance dekhein", pickViewerRegion);
  $("viewerRegionChoice").style.display = "flex";
}

function pickViewerRegion(region) {
  viewerRegion = region;
  $("viewerRegionChoice").style.display = "none";
  $("viewerContent").style.display = "block";
  $("viewerTitle").textContent = `${region} Attendance`;
  if (!$("dateFilter").value) {
    $("dateFilter").value = getTodayIST();
  }
  renderViewerData($("dateFilter").value);
}

$("dateFilter").addEventListener("change", (e) => renderViewerData(e.target.value));

async function renderViewerData(dateStr) {
  const sitesWrap = $("sitesWrap");
  sitesWrap.innerHTML = '<div class="empty">Loading...</div>';

  let plantsQuery = supabaseClient.from("plants").select("*").eq("hidden_from_viewer", false);
  if (viewerRegion) plantsQuery = plantsQuery.eq("region", viewerRegion);

  const [plantsRes, employeesRes, attendanceRes] = await Promise.all([
    plantsQuery.order("name"),
    supabaseClient.from("employees").select("*").eq("is_active", true).order("sort_order").order("name"),
    supabaseClient.from("attendance").select("*").eq("attendance_date", dateStr)
  ]);

  const plants = plantsRes.data || [];
  const employees = employeesRes.data || [];
  const attendanceRows = attendanceRes.data || [];

  const attByEmployee = {};
  attendanceRows.forEach((r) => { attByEmployee[r.employee_id] = r; });
  lastAttendanceById = {};
  lastPlantsById = {};

  let totalPresent = 0, totalAbsent = 0;
  sitesWrap.innerHTML = "";

  plants.forEach((plant) => {
    lastPlantsById[plant.id] = plant;
    const is3 = Number(plant.punches_per_day) === 3;
    const plantEmployees = employees.filter((e) => e.plant_id === plant.id);
    let present = 0, absent = 0;

    const rowsHtml = plantEmployees
      .map((emp) => {
        const rec = attByEmployee[emp.id];
        const isPresent = !!(rec && rec.within_range === true);
        if (isPresent) present++; else absent++;

        const inStr = rec ? formatTime(rec.clock_in_time) : "—";
        const midStr = rec && rec.mid_time ? formatTime(rec.mid_time) : "—";
        const outStr = rec && rec.clock_out_time ? formatTime(rec.clock_out_time) : "—";
        const totalStr = totalHoursText(rec) || "0h 0m";
        const noteStr = rec && !rec.within_range ? " (range se bahar)" : "";

        if (rec) lastAttendanceById[rec.id] = rec;
        const viewBtn = rec
          ? `<button class="photo-btn" data-id="${rec.id}" data-name="${emp.name}">📷 View</button>`
          : `<button class="photo-btn" disabled>—</button>`;

        return `
        <div class="employee-row">
          <div>
            <div class="empname">${emp.name}</div>
            <div class="empmeta">In: ${inStr}${noteStr}${is3 ? `<br>Mid: ${midStr}` : ""}<br>Out: ${outStr}<br>Total: ${totalStr}</div>
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

const MODAL_SECTIONS = {
  in:  { img: "modalInImg",  meta: "modalInMeta",  map: "modalInMapFrame" },
  mid: { img: "modalMidImg", meta: "modalMidMeta", map: "modalMidMapFrame", empty: "modalMidEmpty" },
  out: { img: "modalOutImg", meta: "modalOutMeta", map: "modalOutMapFrame", empty: "modalOutEmpty" }
};

// data = {time, selfie, lat, lng, dist}, or null when that punch hasn't happened yet
function fillModalSection(sec, data, name, label) {
  if (!data) {
    if (sec.empty) $(sec.empty).style.display = "block";
    $(sec.img).style.display = "none";
    $(sec.meta).style.display = "none";
    $(sec.map).src = "";
    $(sec.map).style.display = "none";
    return;
  }

  if (sec.empty) $(sec.empty).style.display = "none";
  $(sec.img).style.display = "block";
  $(sec.img).src = "";
  $(sec.meta).style.display = "block";
  $(sec.meta).textContent = "Loading...";

  if (data.lat && data.lng) {
    $(sec.map).src = mapEmbedUrl(data.lat, data.lng);
    $(sec.map).style.display = "block";
  } else {
    $(sec.map).src = "";
    $(sec.map).style.display = "none";
  }

  const dist = data.dist ? Math.round(data.dist) + "m" : "";
  supabaseClient.storage.from(SELFIE_BUCKET).createSignedUrl(data.selfie, 60).then(({ data: signed, error }) => {
    if (error || !signed) {
      $(sec.meta).textContent = "Selfie load nahi ho payi.";
      return;
    }
    $(sec.img).src = signed.signedUrl;
    $(sec.meta).textContent = `${name} · ${label}: ${formatTime(data.time)}${dist ? " · " + dist : ""}`;
  });
}

async function openSelfieModal(rec, name) {
  $("selfieModal").style.display = "flex";

  const plant = lastPlantsById[rec.plant_id];
  const is3 = !!plant && Number(plant.punches_per_day) === 3;
  $("modalMidSection").style.display = is3 ? "block" : "none";

  fillModalSection(
    MODAL_SECTIONS.in,
    { time: rec.clock_in_time, selfie: rec.selfie_url, lat: rec.latitude, lng: rec.longitude, dist: rec.distance_meters },
    name, "In"
  );

  if (is3) {
    fillModalSection(
      MODAL_SECTIONS.mid,
      rec.mid_time && rec.mid_selfie_url
        ? { time: rec.mid_time, selfie: rec.mid_selfie_url, lat: rec.mid_latitude, lng: rec.mid_longitude, dist: rec.mid_distance_meters }
        : null,
      name, "Dopahar"
    );
  }

  fillModalSection(
    MODAL_SECTIONS.out,
    rec.clock_out_time && rec.clock_out_selfie_url
      ? { time: rec.clock_out_time, selfie: rec.clock_out_selfie_url, lat: rec.clock_out_latitude, lng: rec.clock_out_longitude, dist: rec.clock_out_distance_meters }
      : null,
    name, "Out"
  );
}

$("modalCloseBtn").addEventListener("click", () => {
  $("selfieModal").style.display = "none";
  $("modalInMapFrame").src = "";
  $("modalMidMapFrame").src = "";
  $("modalOutMapFrame").src = "";
});

// ============================================
// INIT
// ============================================
initAuth();
