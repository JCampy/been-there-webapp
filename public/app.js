// ====== CONFIGURATION ======
const API_BASE = window.location.origin;

// Define pin icon URLs
const PUBLIC_PIN_ICON =
  "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png";
const PERSONAL_PIN_ICON =
  "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png"; // Red for personal pins

// ====== STATE ======
let map;
let tempMarker = null;
let tempLatLng = null;
let markers = [];
let currentPlayerName = "Traveler";
let visits = [];
let leaderboardData = [];
let tempCountry = null;
let tempCountryCode = null;

// Track markers by visit ID for highlight/zoom
const visitMarkers = new Map();

// DOM elements
const playerNameInput = document.getElementById("playerName");
const playerNameMobileInput = document.getElementById("playerName_mobile");
const scoreNumberEl = document.getElementById("scoreNumber");
const scoreNumberMobileEl = document.getElementById("scoreNumber_mobile");
const visitsListEl = document.getElementById("visitsList");
const visitsListMobileEl = document.getElementById("visitsList_mobile");
const leaderboardListEl = document.getElementById("leaderboardList");
const leaderboardListMobileEl = document.getElementById(
  "leaderboardList_mobile"
);
const playersCountEl = document.getElementById("playersCount");
const playersCountMobileEl = document.getElementById("playersCount_mobile");
const overlayEl = document.getElementById("overlay");
const verifyPopupEl = document.getElementById("verifyPopup");
const coordsDisplayEl = document.getElementById("coordsDisplay");
const countryLeaderboardListEl = document.getElementById(
  "countryLeaderboardList"
);
const countryLeaderboardListMobileEl = document.getElementById(
  "countryLeaderboardList_mobile"
);
const pinPhotoInput = document.getElementById("pinPhotoInput");

// ====== AUTH TOKEN HELPER ======
function getAuthToken() {
  return window.getSupabaseAccessToken ? window.getSupabaseAccessToken() : null;
}

// ====== USER PROFILE HELPERS ======
async function fetchUserProfile() {
  const token = getAuthToken();
  if (!token) return null;

  try {
    const res = await fetch(`${API_BASE}/api/user/profile`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (res.status === 401) {
      console.warn("Token expired or not logged in");
      return null;
    }
    if (!res.ok) {
      console.warn("Failed to fetch profile:", res.status);
      return null;
    }

    return await res.json(); // { display_name, fallback_name }
  } catch (err) {
    console.error("Error fetching profile:", err);
    return null;
  }
}

async function saveUserDisplayName(name) {
  const token = getAuthToken();
  if (!token) {
    console.warn("No auth token, cannot save display name");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/user/profile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ display_name: name }),
    });

    if (!res.ok) {
      console.warn("Failed to save display name:", res.status);
    } else {
      console.log("Display name saved successfully:", name);
    }
  } catch (err) {
    console.error("Error saving display name:", err);
  }
}

// pull flag images from CDN
function getFlagImageUrl(countryCode) {
  if (!countryCode) return null;
  const code = countryCode.trim().toLowerCase();
  if (code.length !== 2) return null;
  return `https://flagcdn.com/24x18/${code}.png`;
}

// ====== UNICODE FLAG EMOJI CONVERTER ======
function countryCodeToFlagEmoji(countryCode) {
  if (!countryCode) return "";
  const code = countryCode.trim().toUpperCase();
  if (code.length !== 2) return "";

  const OFFSET = 0x1f1e6 - "A".charCodeAt(0);
  const first = String.fromCodePoint(code.charCodeAt(0) + OFFSET);
  const second = String.fromCodePoint(code.charCodeAt(1) + OFFSET);

  return first + second;
}

// ====== FORMAT DATE ======
function formatVisitDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ====== UPDATE NAME UI ======
function updateNameUI(name) {
  currentPlayerName = name || "Traveler";
  if (playerNameInput) playerNameInput.value = currentPlayerName;
  if (playerNameMobileInput) playerNameMobileInput.value = currentPlayerName;
}

// ====== INITIALIZATION ======
document.addEventListener("DOMContentLoaded", async () => {
  currentPlayerName = window.getSupabaseUserName
    ? window.getSupabaseUserName()
    : "Traveler";

  updateNameUI(currentPlayerName);

  initMap();

  try {
    const profile = await fetchUserProfile();
    if (profile) {
      const profileName =
        profile.display_name || profile.fallback_name || currentPlayerName;

      currentPlayerName = profileName;
      updateNameUI(profileName);
      console.log("Loaded display name from profile:", profileName);
    }
  } catch (err) {
    console.warn("Could not load user profile:", err);
  }

  await refreshData().catch((err) =>
    console.warn("Initial data load failed (likely unauthenticated):", err)
  );

  await loadCountryLeaderboard();

  setInterval(loadLeaderboard, 30000);
  setInterval(loadCountryLeaderboard, 30000);
});

async function refreshData() {
  await loadVisits(); // personal visits (for sidebar + score)
  await loadPublicVisits(); // global pins for map
  await loadLeaderboard();
  await loadCountryLeaderboard();
}

// ====== MAP INITIALIZATION ======
function initMap() {
  map = L.map("map").setView([20, 0], 2);

  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    {
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: ["a", "b", "c", "d"],
      maxZoom: 19,
      tileSize: 256,
    }
  ).addTo(map);

  map.on("click", onMapClick);
}

// ====== MAP INTERACTION ======
async function onMapClick(e) {
  tempLatLng = e.latlng;
  tempCountry = null;
  tempCountryCode = null;

  if (tempMarker) {
    map.removeLayer(tempMarker);
  }

  tempMarker = L.marker([e.latlng.lat, e.latlng.lng], {
    icon: L.icon({
      iconUrl:
        "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png",
      shadowUrl:
        "https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png",
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
      shadowSize: [41, 41],
    }),
  }).addTo(map);

  coordsDisplayEl.textContent = `Selected at ~ ${e.latlng.lat.toFixed(
    3
  )}, ${e.latlng.lng.toFixed(3)}`;

  if (pinPhotoInput) {
    pinPhotoInput.value = "";
  }

  overlayEl.classList.add("active");
  verifyPopupEl.classList.add("active");

  const locationInput = document.getElementById("locationName");
  const authToken = getAuthToken();

  if (!authToken) {
    locationInput.disabled = false;
    locationInput.value = "";
    locationInput.placeholder = "Type the place name...";
    locationInput.focus();
    return;
  }

  locationInput.value = "Looking up location...";
  locationInput.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/reverse-geocode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        lat: e.latlng.lat,
        lng: e.latlng.lng,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Reverse-geocode failed:", res.status, data);
      throw new Error(data.error || "Failed to auto-detect place name");
    }

    if (data.place_name) {
      locationInput.value = data.place_name;
    } else {
      locationInput.value = "";
      locationInput.placeholder = "Type the place name...";
    }

    tempCountry = data.country || null;
    tempCountryCode = data.country_code || null;
  } catch (err) {
    console.error("Reverse geocoding error:", err);
    tempCountry = null;
    tempCountryCode = null;
    locationInput.value = "";
    locationInput.placeholder = "Type the place name...";
  } finally {
    locationInput.disabled = false;
    locationInput.focus();
    if (locationInput.value) {
      locationInput.select();
    }
  }
}

// ====== PHOTO UPLOAD HELPER (no getSupabaseUser dependency) ======
async function uploadPinPhoto(file) {
  if (!file) return null;

  const supabase = window.supabaseClient;
  if (!supabase) {
    console.warn("Supabase client not available on window");
    return null;
  }

  const ext = file.name.split(".").pop() || "jpg";
  const fileName = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.${ext}`;
  const filePath = `pins/${fileName}`;

  const { data, error: uploadError } = await supabase.storage
    .from("pin-photos")
    .upload(filePath, file, {
      cacheControl: "3600",
      upsert: false,
    });

  if (uploadError) {
    alert(
      "Failed to upload photo: " + (uploadError.message || "Unknown error")
    );
    return null;
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("pin-photos").getPublicUrl(filePath);

  return publicUrl;
}

// ====== VERIFY / CONFIRM PIN ======
async function confirmPin() {
  const locationName = document.getElementById("locationName").value.trim();

  if (!locationName) {
    alert("Please enter a location name!");
    return;
  }

  if (locationName.length < 2) {
    alert("Please enter a valid location name (at least 2 characters)!");
    return;
  }

  const authToken = getAuthToken();
  if (!authToken) {
    alert("Please sign in with Google to add visits!");
    closePopup();
    return;
  }

  const photoFile = pinPhotoInput?.files?.[0] || null;
  let photoUrl = null;
  if (photoFile) {
    photoUrl = await uploadPinPhoto(photoFile);
  }

  try {
    const res = await fetch(`${API_BASE}/api/visits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        lat: tempLatLng.lat,
        lng: tempLatLng.lng,
        place_name: locationName,
        country: tempCountry,
        country_code: tempCountryCode,
        photo_url: photoUrl,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to add visit");
    }

    addVisitMarker(data);
    closePopup();

    await refreshData();
  } catch (err) {
    alert(err.message);
  }
}

function cancelPin() {
  if (tempMarker) {
    map.removeLayer(tempMarker);
    tempMarker = null;
  }
  closePopup();
}

function closePopup() {
  overlayEl.classList.remove("active");
  verifyPopupEl.classList.remove("active");
}

// ====== LOAD VISITS (current user) ======
async function loadVisits() {
  const authToken = getAuthToken();
  if (!authToken) {
    visits = [];
    clearAllMarkers();
    scoreNumberEl.textContent = "0";
    if (scoreNumberMobileEl) scoreNumberMobileEl.textContent = "0";
    renderVisitsList([]);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/visits`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (!res.ok) {
      throw new Error("Failed to load visits");
    }

    visits = await res.json();

    scoreNumberEl.textContent = visits.length;
    if (scoreNumberMobileEl) scoreNumberMobileEl.textContent = visits.length;

    renderVisitsList(visits);
  } catch (err) {
    console.error("Failed to load visits:", err);
  }
}

// ====== LOAD PUBLIC VISITS (all users) ======
async function loadPublicVisits() {
  try {
    const res = await fetch(`${API_BASE}/api/visits/public`);

    if (!res.ok) {
      throw new Error("Failed to load public visits");
    }

    const publicVisits = await res.json();

    clearAllMarkers();
    publicVisits.forEach((visit) => addVisitMarker(visit));
  } catch (err) {
    console.error("Failed to load public visits:", err);
  }
}

// ====== RENDER VISITS LIST ======
function renderVisitsList(visitsList) {
  if (!visitsList || visitsList.length === 0) {
    visitsListEl.innerHTML =
      '<div style="text-align: center; color: #9ca3af; padding: 20px; font-size: 12px;">No visits yet. Click the map to add your first!</div>';
    if (visitsListMobileEl)
      visitsListMobileEl.innerHTML =
        '<div style="text-align: center; color: #9ca3af; padding: 20px; font-size: 12px;">No visits yet. Click the map to add your first!</div>';
    return;
  }

  visitsListEl.innerHTML = "";
  if (visitsListMobileEl) visitsListMobileEl.innerHTML = "";

  visitsList.forEach((visit) => {
    const item = document.createElement("div");
    item.className = "visit-item";

    const main = document.createElement("div");
    main.className = "visit-main";

    const title = document.createElement("div");
    title.className = "visit-location";

    const flagUrl = getFlagImageUrl(visit.country_code);
    const locationText =
      visit.place_name || visit.country || "Unknown location";

    if (flagUrl) {
      const img = document.createElement("img");
      img.src = flagUrl;
      img.alt = (visit.country_code || "").toUpperCase();
      img.style.width = "18px";
      img.style.height = "12px";
      img.style.objectFit = "cover";
      img.style.borderRadius = "2px";
      img.style.marginRight = "6px";
      img.style.verticalAlign = "middle";
      title.appendChild(img);
    }

    const textNode = document.createTextNode(locationText);
    title.appendChild(textNode);

    const meta = document.createElement("div");
    meta.className = "visit-meta";
    const coordsText = `${visit.lat.toFixed(2)}, ${visit.lng.toFixed(2)}`;
    const dateText = formatVisitDate(visit.created_at);
    meta.textContent = `${coordsText} · ${dateText}`;

    main.appendChild(title);
    main.appendChild(meta);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.textContent = "✕";
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteVisit(visit.id);
    };

    item.appendChild(main);
    item.appendChild(deleteBtn);

    item.style.cursor = "pointer";
    item.addEventListener("click", (e) => {
      if (
        e.target.classList.contains("delete-btn") ||
        e.target.closest(".delete-btn")
      ) {
        return;
      }

      if (map) {
        const targetZoom = Math.max(map.getZoom(), 6);
        map.setView([visit.lat, visit.lng], targetZoom, {
          animate: true,
          duration: 0.5,
        });
        highlightMarkerForVisit(visit.id);
      }
    });

    visitsListEl.appendChild(item);
    if (visitsListMobileEl)
      visitsListMobileEl.appendChild(item.cloneNode(true));
  });
}

// ====== HIGHLIGHT MARKER ======
function highlightMarkerForVisit(visitId) {
  const marker = visitMarkers.get(visitId);
  if (!marker) return;

  marker.openPopup();

  const iconEl = marker._icon;
  if (!iconEl) return;

  iconEl.classList.add("marker-highlight");

  setTimeout(() => {
    iconEl.classList.remove("marker-highlight");
  }, 1000);
}

// ====== DELETE VISIT ======
async function deleteVisit(id) {
  if (!confirm("Delete this visit?")) return;

  const authToken = getAuthToken();
  if (!authToken) {
    alert("Please sign in to delete visits!");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/visits/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (!res.ok) {
      throw new Error("Failed to delete visit");
    }

    await refreshData();
  } catch (err) {
    alert(err.message);
  }
}

// ====== CLEAR ALL VISITS ======
async function clearVisits() {
  if (
    !confirm(
      "Are you sure you want to clear all your visits? This cannot be undone."
    )
  ) {
    return;
  }

  const authToken = getAuthToken();
  if (!authToken) {
    alert("Please sign in to clear visits!");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/visits`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (!res.ok) {
      throw new Error("Failed to load visits");
    }

    const visitsToDelete = await res.json();

    for (const visit of visitsToDelete) {
      await fetch(`${API_BASE}/api/visits/${visit.id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
    }

    await refreshData();
  } catch (err) {
    alert("Failed to clear visits: " + err.message);
  }
}

// ====== LOAD LEADERBOARD ======
async function loadLeaderboard() {
  try {
    const res = await fetch(`${API_BASE}/api/leaderboard`);

    if (!res.ok) {
      throw new Error("Failed to load leaderboard");
    }

    leaderboardData = await res.json();
    renderLeaderboard(leaderboardData);
  } catch (err) {
    console.error("Failed to load leaderboard:", err);
  }
}

// ====== RENDER LEADERBOARD ======
function renderLeaderboard(leaderboard) {
  if (leaderboard.length === 0) {
    leaderboardListEl.innerHTML =
      '<div style="text-align: center; color: #9ca3af; padding: 20px; font-size: 12px;">No players yet. Be the first!</div>';
    if (leaderboardListMobileEl)
      leaderboardListMobileEl.innerHTML =
        '<div style="text-align: center; color: #9ca3af; padding: 20px; font-size: 12px;">No players yet. Be the first!</div>';
    playersCountEl.innerHTML = "<strong>0</strong> players";
    if (playersCountMobileEl)
      playersCountMobileEl.innerHTML = "<strong>0</strong> players";
    document.getElementById("onlineCount").textContent = "No players yet";
    return;
  }

  leaderboardListEl.innerHTML = "";
  if (leaderboardListMobileEl) leaderboardListMobileEl.innerHTML = "";

  leaderboard.slice(0, 10).forEach((player, index) => {
    const item = document.createElement("div");
    item.className = index === 0 ? "leader-item first" : "leader-item";

    const initials =
      player.name
        .split(" ")
        .filter(Boolean)
        .map((part) => part[0].toUpperCase())
        .slice(0, 2)
        .join("") || "T";

    const visitCount = parseInt(player.visit_count) || 0;
    const visitText =
      visitCount === 1 ? "1 place visited" : `${visitCount} places visited`;

    item.innerHTML = `
      <div class="leader-rank">${index + 1}</div>
      <div class="leader-avatar">${initials}</div>
      <div class="leader-body">
        <div class="leader-name">${escapeHtml(player.name)}</div>
        <div class="leader-meta">${visitText}</div>
      </div>
      <div class="leader-score">${visitCount}<span> pts</span></div>
    `;

    leaderboardListEl.appendChild(item);
    if (leaderboardListMobileEl)
      leaderboardListMobileEl.appendChild(item.cloneNode(true));
  });

  const totalPlayers = leaderboard.length;
  playersCountEl.innerHTML = `<strong>${totalPlayers}</strong> ${
    totalPlayers === 1 ? "player" : "players"
  }`;
  if (playersCountMobileEl)
    playersCountMobileEl.innerHTML = `<strong>${totalPlayers}</strong> ${
      totalPlayers === 1 ? "player" : "players"
    }`;
  document.getElementById("onlineCount").textContent =
    totalPlayers > 1 ? `${totalPlayers} players online` : "You & others";
}

// ====== LOAD COUNTRY LEADERBOARD ======
async function loadCountryLeaderboard() {
  if (!countryLeaderboardListEl) return;

  try {
    const res = await fetch(`${API_BASE}/api/leaderboard/countries`);

    if (!res.ok) {
      throw new Error("Failed to load country leaderboard");
    }

    const data = await res.json();
    renderCountryLeaderboard(data);
  } catch (err) {
    console.error("Failed to load country leaderboard:", err);
  }
}

// ====== RENDER COUNTRY LEADERBOARD ======
function renderCountryLeaderboard(entries) {
  if (!countryLeaderboardListEl) return;

  if (entries.length === 0) {
    countryLeaderboardListEl.innerHTML =
      '<div style="text-align: center; color: #9ca3af; padding: 20px; font-size: 12px;">No countries visited yet!</div>';
    if (countryLeaderboardListMobileEl)
      countryLeaderboardListMobileEl.innerHTML =
        '<div style="text-align: center; color: #9ca3af; padding: 20px; font-size: 12px;">No countries visited yet!</div>';
    return;
  }

  countryLeaderboardListEl.innerHTML = "";
  if (countryLeaderboardListMobileEl)
    countryLeaderboardListMobileEl.innerHTML = "";

  entries.slice(0, 20).forEach((entry, index) => {
    const item = document.createElement("div");
    item.className = index === 0 ? "leader-item first" : "leader-item";

    const flagUrl = getFlagImageUrl(entry.country_code);
    let avatarHtml;
    if (flagUrl) {
      avatarHtml = `<img src="${flagUrl}" alt="${(
        entry.country_code || ""
      ).toUpperCase()}" style="width: 20px; height: 14px; object-fit: cover; border-radius: 2px;" />`;
    } else {
      avatarHtml = "🌍";
    }

    const visitCount = parseInt(entry.visit_count) || 0;
    const visitText = visitCount === 1 ? "1 visit" : `${visitCount} visits`;

    item.innerHTML = `
      <div class="leader-rank">${index + 1}</div>
      <div class="leader-avatar" style="background: none; padding: 0; display: flex; align-items: center; justify-content: center;">
        ${avatarHtml}
      </div>
      <div class="leader-body">
        <div class="leader-name">${escapeHtml(entry.country)}</div>
        <div class="leader-meta">${visitText}</div>
      </div>
      <div class="leader-score">${visitCount}<span> pts</span></div>
    `;

    countryLeaderboardListEl.appendChild(item);
    if (countryLeaderboardListMobileEl)
      countryLeaderboardListMobileEl.appendChild(item.cloneNode(true));
  });
}

// ====== MARKER MANAGEMENT ======
function addVisitMarker(visit) {
  const currentUserId = window.getSupabaseUserId
    ? window.getSupabaseUserId()
    : null;

  const iconUrl =
    currentUserId && visit.user_id === currentUserId
      ? PERSONAL_PIN_ICON
      : PUBLIC_PIN_ICON;

  const marker = L.marker([visit.lat, visit.lng], {
    icon: L.icon({
      iconUrl,
      shadowUrl:
        "https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png",
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
      shadowSize: [41, 41],
    }),
  }).addTo(map);

  const ownerName = visit.display_name || visit.owner_name || "Traveler";

  let popupHtml = `<b>${escapeHtml(
    visit.place_name || visit.country || "Unknown location"
  )}</b><br>by ${escapeHtml(ownerName)}`;

  if (visit.photo_url) {
    popupHtml += `<br><img src="${visit.photo_url}" style="margin-top: 6px; max-width: 220px; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.4);" />`;
  }

  marker.bindPopup(popupHtml);

  markers.push(marker);

  if (visit.id) {
    visitMarkers.set(visit.id, marker);
  }
}

// ====== CLEAR ALL MARKERS ======
function clearAllMarkers() {
  if (!map) return;
  markers.forEach((marker) => {
    map.removeLayer(marker);
  });
  markers = [];
  visitMarkers.clear();
}

// ====== PLAYER NAME UPDATE ======
if (playerNameInput) {
  playerNameInput.addEventListener("change", (e) => {
    const newName = e.target.value.trim() || "Traveler";
    currentPlayerName = newName;
    updateNameUI(newName);
    saveUserDisplayName(newName);
  });
}
if (playerNameMobileInput) {
  playerNameMobileInput.addEventListener("change", (e) => {
    const newName = e.target.value.trim() || "Traveler";
    currentPlayerName = newName;
    updateNameUI(newName);
    saveUserDisplayName(newName);
  });
}

// ====== UTILITY FUNCTIONS ======
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ====== KEYBOARD SHORTCUTS ======
document
  .getElementById("locationName")
  .addEventListener("keypress", function (e) {
    if (e.key === "Enter") {
      confirmPin();
    }
  });

// Make functions available globally
window.confirmPin = confirmPin;
window.cancelPin = cancelPin;
window.deleteVisit = deleteVisit;
window.clearVisits = clearVisits;

// ====== ERROR HANDLING ======
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
});

// ====== AUTH STATE HANDLERS (called from auth.js) ======
async function handleLogin() {
  visits = [];
  clearAllMarkers();
  scoreNumberEl.textContent = "0";
  if (scoreNumberMobileEl) scoreNumberMobileEl.textContent = "0";

  try {
    const profile = await fetchUserProfile();
    if (profile) {
      const profileName =
        profile.display_name || profile.fallback_name || "Traveler";
      currentPlayerName = profileName;
      updateNameUI(profileName);
    }
  } catch (err) {
    console.warn("Could not refresh profile on login:", err);
  }

  await refreshData();
}

function handleLogout() {
  visits = [];
  clearAllMarkers();
  scoreNumberEl.textContent = "0";
  if (scoreNumberMobileEl) scoreNumberMobileEl.textContent = "0";

  renderVisitsList([]);
}

window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
