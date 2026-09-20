// ============================================
// SELFIE ATTENDANCE — APP LOGIC
// ============================================

const supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);

const $ = (id) => document.getElementById(id);

let currentUser = null;      // supabase auth user
let currentEmployee = null;  // row from employees table
let currentPlant = null;     // row from plants table
let mediaStream = null;
let capturedBlob = null;
let lastLocation = null;     // {lat, lng, accuracy}
let lastDistance = null;
let deviceMismatch = false;

// ---------- DEVICE ID ----------
function getDeviceId() {
  let id = localStorage.getItem("attendance_device_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("attendance_device_id", id);
  }
  return id;
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
  // First try: high accuracy GPS, 20s timeout.
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      (err) => {
        if (err.code === err.TIMEOUT) {
          // Fallback: relax accuracy requirement, give it more time.
          // This trades precision for a much higher chance of success indoors.
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

// ---------- AUTH ----------
$("googleLoginBtn").addEventListener("click", async () => {
  $("authStatus").textContent = "Redirecting to Google...";
  await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href.split("#")[0] }
  });
});

$("signoutBtn").addEventListener("click", async () => {
  stopCamera();
  await supabaseClient.auth.signOut();
  window.location.reload();
});

async function initAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    currentUser = session.user;
    await loadEmployee();
  } else {
    $("authSection").style.display = "block";
    $("mainSection").style.display = "none";
  }
}

async function loadEmployee() {
  $("authSection").style.display = "none";
  $("mainSection").style.display = "block";

  const email = currentUser.email;
  const { data: emp, error } = await supabaseClient
    .from("employees")
    .select("*, plants(*)")
    .eq("email", email)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !emp) {
    $("notRegistered").style.display = "block";
    $("empName").textContent = email;
    $("empPlant").textContent = "Not registered";
    return;
  }

  currentEmployee = emp;
  currentPlant = emp.plants;
  $("empName").textContent = emp.name;
  $("empPlant").textContent = currentPlant ? currentPlant.name : "No plant assigned";

  await checkDeviceBinding();
  await loadHistory();
}

// ---------- DEVICE BINDING ----------
async function checkDeviceBinding() {
  const myDeviceId = getDeviceId();

  if (!currentEmployee.device_id) {
    // first login on any device — bind it
    await supabaseClient
      .from("employees")
      .update({ device_id: myDeviceId, device_locked: true })
      .eq("id", currentEmployee.id);
    currentEmployee.device_id = myDeviceId;
    deviceMismatch = false;
  } else if (currentEmployee.device_id !== myDeviceId) {
    deviceMismatch = true;
    $("deviceWarning").style.display = "block";
  } else {
    deviceMismatch = false;
  }
}

// ---------- CAMERA ----------
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
    $("captureStatus").textContent =
      "Camera access nahi mila: " + (e.message || "permission denied");
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
  const video = $("video");
  const canvas = $("canvas");

  // Resize down for compression (max width 480px)
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
    $("verdictVal").textContent = inRange
      ? "Plant range ke andar"
      : "Plant range se bahar";
    $("verdictVal").className = "verdict " + (inRange ? "in" : "out");

    $("radarBox").style.display = "flex";
    $("radarBox").innerHTML = drawRadar(
      distance,
      currentPlant.radius_meters,
      inRange
    );

    $("submitBtn").style.display = "block";
  } catch (e) {
    $("captureStatus").textContent =
      "Location nahi mil payi: " +
      (e.message || "permission denied. Location allow karein.");
  }
}

// ---------- SUBMIT ----------
async function submitAttendance() {
  if (!capturedBlob || !lastLocation) return;
  $("submitBtn").disabled = true;
  $("captureStatus").textContent = "Attendance submit ho rahi hai...";

  try {
    const fileName = `${currentEmployee.id}/${Date.now()}.jpg`;
    const { error: uploadError } = await supabaseClient.storage
      .from(SELFIE_BUCKET)
      .upload(fileName, capturedBlob, { contentType: "image/jpeg" });

    if (uploadError) throw uploadError;

    const inRange = lastDistance <= currentPlant.radius_meters;
    // Low-confidence GPS reading gets flagged for manual review, same as a
    // device mismatch — neither blocks the punch, both surface it later.
    const lowAccuracy = lastLocation.accuracy > 50;
    const status =
      deviceMismatch || lowAccuracy || !inRange ? "flagged" : "ok";

    const { error: insertError } = await supabaseClient.from("attendance").insert({
      employee_id: currentEmployee.id,
      plant_id: currentPlant.id,
      latitude: lastLocation.lat,
      longitude: lastLocation.lng,
      gps_accuracy: lastLocation.accuracy,
      distance_meters: lastDistance,
      within_range: inRange,
      selfie_url: fileName,
      device_id: getDeviceId(),
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
    await loadHistory();
  } catch (e) {
    $("captureStatus").textContent = "Submit fail hua: " + (e.message || e);
  } finally {
    $("submitBtn").disabled = false;
  }
}

// ---------- HISTORY ----------
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
        <td>${new Date(r.clock_in_time).toLocaleString("en-IN")}</td>
        <td>${formatDistance(r.distance_meters)}</td>
        <td><span class="tag ${tagClass}">${label}</span></td>
      </tr>`;
    })
    .join("");

  wrap.innerHTML = `
    <table>
      <thead><tr><th>Time</th><th>Distance</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------- INIT ----------
supabaseClient.auth.onAuthStateChange((_event, session) => {
  if (session && !currentUser) {
    currentUser = session.user;
    loadEmployee();
  }
});

initAuth();
