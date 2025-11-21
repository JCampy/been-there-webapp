// public/auth.js

// === CONFIG: replace with your project values ===
const SUPABASE_URL = "https://xhajkvjdchtecnjygoks.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhoYWprdmpkY2h0ZWNuanlnb2tzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM2MjIyODMsImV4cCI6MjA3OTE5ODI4M30.F8mKI80g29Ym90C0Db_sp4SSoF8iIsViYjJYnVTbtI0";

// Debug: see what we actually have
console.log("auth.js: window.supabase =", window.supabase);

// Only create client if window.supabase exists
const supabase = window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// Where we store the JWT token
const ACCESS_TOKEN_KEY = "supabaseAccessToken";
const USER_NAME_KEY = "supabaseUserName";

// Elements
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const userChipEl = document.getElementById("userChip");
const userAvatarEl = document.getElementById("userAvatar");
const userChipNameEl = document.getElementById("userChipName");

// Expose client to app.js if needed
window.supabaseClient = supabase;

// === Initialize auth state on page load ===
document.addEventListener("DOMContentLoaded", async () => {
  if (!supabase) {
    console.warn("Supabase client is null; skipping auth initialization.");
    applyLoggedOutUI();
    return;
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.user) {
    const accessToken = session.access_token;
    const name =
      session.user.user_metadata?.full_name ||
      session.user.user_metadata?.name ||
      session.user.email?.split("@")[0] ||
      "Traveler";

    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(USER_NAME_KEY, name);
    applyUserUI(name);

    // NEW: tell app.js user is logged in so it can load visits
    if (window.handleLogin) {
      window.handleLogin();
    }
  } else {
    applyLoggedOutUI();

    // NEW: tell app.js user is logged out so it can clear visits
    if (window.handleLogout) {
      window.handleLogout();
    }
  }
});

// === Login / Logout handlers ===
if (loginBtn) {
  loginBtn.addEventListener("click", async () => {
    if (!supabase) {
      alert("Supabase is not available. Check the script tag in <head>.");
      return;
    }

    const redirectTo = window.location.origin; // e.g. http://localhost:4000

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
      },
    });

    if (error) {
      console.error("Supabase login error:", error.message);
      alert("Login failed: " + error.message);
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(USER_NAME_KEY);
    applyLoggedOutUI();

    if (window.handleLogout) {
      window.handleLogout();
    }
  });
}

// === UI helpers ===
function applyUserUI(name) {
  if (!name) name = "Traveler";

  if (loginBtn) loginBtn.style.display = "none";
  if (userChipEl) userChipEl.style.display = "flex";

  if (userChipNameEl) userChipNameEl.textContent = name;

  const nameInput = document.getElementById("playerName");
  if (nameInput) nameInput.value = name;

  const initials = name
    .split(" ")
    .filter(Boolean)
    .map((p) => p[0].toUpperCase())
    .slice(0, 2)
    .join("");
  if (userAvatarEl) userAvatarEl.textContent = initials || "T";

  window.currentDisplayName = name;
}

function applyLoggedOutUI() {
  if (loginBtn) loginBtn.style.display = "inline-flex";
  if (userChipEl) userChipEl.style.display = "none";

  const fallback = "Traveler";

  const nameInput = document.getElementById("playerName");
  if (nameInput) nameInput.value = fallback;

  if (userChipNameEl) userChipNameEl.textContent = fallback;
  if (userAvatarEl) userAvatarEl.textContent = "T";

  window.currentDisplayName = fallback;
}

// Utility: get current token for app.js
window.getSupabaseAccessToken = function () {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
};

// Utility: get current display name for app.js
window.getSupabaseUserName = function () {
  return (
    localStorage.getItem(USER_NAME_KEY) ||
    window.currentDisplayName ||
    "Traveler"
  );
};
