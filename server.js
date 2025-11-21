const express = require("express");
const cors = require("cors");
const path = require("path");
const { supabaseAdmin } = require("./supabase");
const { authenticateToken } = require("./middleware/auth");
require("dotenv").config();

// Very simple in-memory cache for reverse geocoding
// Key: "latRounded,lngRounded"  (e.g. "41.903,12.496")
// Value: { data: { place_name, country, country_code, raw }, expiresAt: timestamp }
const reverseGeoCache = new Map();

// How many milliseconds to keep a cached entry (e.g. 24 hours)
const REVERSE_GEO_TTL_MS = 24 * 60 * 60 * 1000;

// Round coordinates to this many decimal places for cache keys.
// 3 decimals ≈ 100–150m, 2 decimals ≈ ~1km.
const REVERSE_GEO_PRECISION = 3;

function makeCacheKey(lat, lng) {
  const factor = Math.pow(10, REVERSE_GEO_PRECISION);
  const latKey = Math.round(lat * factor) / factor;
  const lngKey = Math.round(lng * factor) / factor;
  return `${latKey},${lngKey}`;
}

const app = express();
const PORT = process.env.PORT || 4000;
const COUNTRY_NAMES_EN = {
  us: "United States",
  ca: "Canada",
  mx: "Mexico",
  gb: "United Kingdom",
  fr: "France",
  de: "Germany",
  it: "Italy",
  es: "Spain",
  pt: "Portugal",
  au: "Australia",
  nz: "New Zealand",
  br: "Brazil",
  ar: "Argentina",
  jp: "Japan",
  cn: "China",
  in: "India",
};

// Middleware
const allowedOrigins = [
  "http://localhost:4000",
  "http://localhost:3000",
  "https://been-there-webapp.onrender.com",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, Postman, curl)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(express.static("public"));

// ===== HEALTH CHECK =====
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/db-test", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from("visits").select("count");

    if (error) throw error;

    res.json({
      status: "connected",
      message: "Database connection successful",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== USER PROFILE ROUTES =====

// GET /api/user/profile - get current user's profile
app.get("/api/user/profile", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.error("Error fetching profile:", error);
      return res.status(500).json({ error: "Failed to load profile" });
    }

    const fallbackName =
      (req.user.user_metadata && req.user.user_metadata.full_name) ||
      "Traveler";

    res.json({
      display_name: data?.display_name || null,
      fallback_name: fallbackName,
    });
  } catch (err) {
    console.error("GET /api/user/profile error:", err);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// POST /api/user/profile - update current user's display name
app.post("/api/user/profile", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { display_name } = req.body;

    console.log(
      "PROFILE POST userId:",
      userId,
      "display_name payload:",
      display_name
    );

    const safeName = (display_name || "").trim().slice(0, 50);
    if (!safeName) {
      console.log("PROFILE POST rejected: empty safeName");
      return res.status(400).json({ error: "Display name is required" });
    }

    const fullName =
      (req.user.user_metadata && req.user.user_metadata.full_name) || safeName;

    console.log("PROFILE UPSERT payload:", {
      id: userId,
      name: fullName,
      display_name: safeName,
    });

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .upsert(
        {
          id: userId,
          name: fullName, // NOT NULL
          display_name: safeName, // nickname
        },
        { onConflict: "id" }
      )
      .select();

    console.log("PROFILE UPSERT result:", { data, error });

    if (error) {
      console.error("Error updating profile:", error);
      return res.status(500).json({ error: "Failed to save profile" });
    }

    return res.json({ display_name: safeName });
  } catch (err) {
    console.error("POST /api/user/profile error:", err);
    return res.status(500).json({ error: "Failed to save profile" });
  }
});

// ===== VISITS ROUTES =====

// GET /api/visits - list current user's visits
app.get("/api/visits", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabaseAdmin
      .from("visits")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("Error fetching visits:", err);
    res.status(500).json({ error: "Failed to load visits" });
  }
});

// POST /api/visits - add a new visit
app.post("/api/visits", authenticateToken, async (req, res) => {
  try {
    const { lat, lng, place_name, country, country_code, photo_url } = req.body;

    if (!lat || !lng || !place_name) {
      return res
        .status(400)
        .json({ error: "lat, lng, and place_name required" });
    }

    // Check for nearby duplicates (within ~1km = 0.01 degrees)
    const { data: nearby, error: nearbyError } = await supabaseAdmin
      .from("visits")
      .select("*")
      .eq("user_id", req.user.id)
      .gte("lat", lat - 0.01)
      .lte("lat", lat + 0.01)
      .gte("lng", lng - 0.01)
      .lte("lng", lng + 0.01);

    if (nearbyError) throw nearbyError;

    if (nearby && nearby.length > 0) {
      return res.status(400).json({ error: "You already have a visit nearby" });
    }

    // Insert new visit including optional photo_url
    const { data, error } = await supabaseAdmin
      .from("visits")
      .insert([
        {
          user_id: req.user.id,
          lat: parseFloat(lat),
          lng: parseFloat(lng),
          place_name,
          country: country || null,
          country_code: country_code || null,
          photo_url: photo_url || null,
        },
      ])
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return res
          .status(400)
          .json({ error: "Duplicate visit at this exact location" });
      }
      throw error;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/visits/public - list recent visits for public map
app.get("/api/visits/public", async (req, res) => {
  try {
    // 1) Get recent visits
    const { data: visits, error: visitsError } = await supabaseAdmin
      .from("visits")
      .select(
        "id, user_id, lat, lng, place_name, country, country_code, photo_url, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(500);

    if (visitsError) {
      console.error("Error fetching visits for public map:", visitsError);
      return res.status(500).json({ error: "Failed to load public visits" });
    }

    if (!visits || visits.length === 0) {
      return res.json([]); // no visits yet
    }

    // 2) Get profiles for those user_ids
    const userIds = [...new Set(visits.map((v) => v.user_id).filter(Boolean))];

    let nameById = new Map();

    if (userIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabaseAdmin
        .from("profiles")
        .select("id, display_name")
        .in("id", userIds);

      if (profilesError) {
        console.error(
          "Error fetching profiles for public visits:",
          profilesError
        );
        // Continue; we will just fall back to "Traveler"
      } else if (profiles) {
        nameById = new Map(
          profiles.map((p) => [p.id, p.display_name || "Traveler"])
        );
      }
    }

    // 3) Attach display_name to each visit
    const withNames = visits.map((v) => ({
      ...v,
      display_name: nameById.get(v.user_id) || "Traveler",
    }));

    res.json(withNames);
  } catch (err) {
    console.error("Error fetching public visits:", err);
    res.status(500).json({ error: "Failed to load public visits" });
  }
});

// DELETE /api/visits/:id - delete a visit (and its photo if present)
app.delete("/api/visits/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // 1) Load the visit so we can get photo_url
    const { data: visit, error: fetchError } = await supabaseAdmin
      .from("visits")
      .select("id, user_id, photo_url")
      .eq("id", id)
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (fetchError) {
      console.error("Error fetching visit to delete:", fetchError);
      return res.status(500).json({ error: "Failed to load visit" });
    }

    if (!visit) {
      return res.status(404).json({ error: "Visit not found" });
    }

    // 2) If a photo exists, delete it from Storage
    if (visit.photo_url) {
      try {
        console.log("Attempting to delete photo:", visit.photo_url);

        // Split on the public bucket prefix
        const SPLIT_MARKER = "/storage/v1/object/public/pin-photos/";
        const parts = visit.photo_url.split(SPLIT_MARKER);

        if (parts.length !== 2 || !parts[1]) {
          console.warn(
            "Could not derive storage path from photo_url; parts:",
            parts
          );
        } else {
          const relativePath = parts[1]; // e.g. "pins/1763697066566-vfalckpdb.jpg"
          console.log("Derived storage path:", relativePath);

          const { error: removeError } = await supabaseAdmin.storage
            .from("pin-photos")
            .remove([relativePath]);

          if (removeError) {
            console.warn("Failed to remove photo from storage:", removeError);
          } else {
            console.log("Successfully removed photo from storage");
          }
        }
      } catch (e) {
        console.warn("Error while parsing/removing photo_url:", e);
      }
    }

    // 3) Delete the visit row itself
    const { data: deleted, error: deleteError } = await supabaseAdmin
      .from("visits")
      .delete()
      .eq("id", id)
      .eq("user_id", req.user.id)
      .select()
      .single();

    if (deleteError) {
      if (deleteError.code === "PGRST116") {
        return res.status(404).json({ error: "Visit not found" });
      }
      throw deleteError;
    }

    return res.json({ message: "Visit deleted", visit: deleted });
  } catch (err) {
    console.error("DELETE /api/visits/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== LEADERBOARD ROUTE (users, grouped by user_id with profiles) =====
app.get("/api/leaderboard", async (req, res) => {
  try {
    // 1) Get all visits and count by user_id in Node
    const { data: visitRows, error: visitsError } = await supabaseAdmin
      .from("visits")
      .select("user_id");

    if (visitsError) {
      console.error("Error fetching visits for leaderboard:", visitsError);
      return res.status(500).json({ error: "Failed to fetch leaderboard" });
    }

    // Count visits per user_id
    const countsByUser = new Map();
    for (const row of visitRows || []) {
      if (!row.user_id) continue;
      countsByUser.set(row.user_id, (countsByUser.get(row.user_id) || 0) + 1);
    }

    if (countsByUser.size === 0) {
      return res.json([]);
    }

    // 2) Fetch profiles for all user_ids
    const userIds = Array.from(countsByUser.keys());

    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name")
      .in("id", userIds);

    if (profilesError) {
      console.error("Error fetching profiles for leaderboard:", profilesError);
      return res.status(500).json({ error: "Failed to fetch leaderboard" });
    }

    // Map user_id -> display_name
    const nameById = new Map();
    for (const profile of profiles || []) {
      nameById.set(profile.id, profile.display_name);
    }

    // 3) Build leaderboard using current profile names
    const leaderboard = Array.from(countsByUser.entries()).map(
      ([userId, count]) => {
        const name = nameById.get(userId) || "Traveler";
        return {
          user_id: userId,
          name,
          visit_count: count,
        };
      }
    );

    // 4) Sort by visit_count descending and limit to top 50
    leaderboard.sort((a, b) => b.visit_count - a.visit_count);

    res.json(leaderboard.slice(0, 50));
  } catch (err) {
    console.error("Unexpected error in /api/leaderboard:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Country leaderboard
app.get("/api/leaderboard/countries", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("visits")
      .select("country, country_code");

    if (error) {
      console.error("Error fetching visits for country leaderboard:", error);
      return res
        .status(500)
        .json({ error: "Failed to fetch country leaderboard" });
    }

    const countsByCode = new Map();

    for (const row of data || []) {
      const code = row.country_code?.toLowerCase();
      if (!code) continue;

      const label = row.country || code.toUpperCase();

      if (!countsByCode.has(code)) {
        countsByCode.set(code, {
          country_code: code,
          labelCounts: new Map(),
          visit_count: 0,
        });
      }

      const entry = countsByCode.get(code);
      entry.visit_count += 1;
      entry.labelCounts.set(label, (entry.labelCounts.get(label) || 0) + 1);
    }

    const leaderboard = Array.from(countsByCode.values()).map((entry) => {
      let bestLabel = null;
      let bestCount = -1;
      for (const [label, count] of entry.labelCounts.entries()) {
        if (count > bestCount) {
          bestCount = count;
          bestLabel = label;
        }
      }

      return {
        country_code: entry.country_code,
        country: bestLabel || entry.country_code.toUpperCase(),
        visit_count: entry.visit_count,
      };
    });

    leaderboard.sort((a, b) => b.visit_count - a.visit_count);

    res.json(leaderboard.slice(0, 50));
  } catch (err) {
    console.error("Unexpected error in /api/leaderboard/countries:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===== REVERSE GEOCODE ROUTE =====
// Body: { lat: number, lng: number }
// Returns: { place_name, country, country_code, raw }
app.post("/api/reverse-geocode", authenticateToken, async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng must be numbers" });
    }

    // ---- 1) Check cache ----
    const cacheKey = makeCacheKey(lat, lng);
    const cached = reverseGeoCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      // console.log("Reverse-geocode cache hit:", cacheKey);
      return res.json(cached.data);
    }

    // ---- 2) Not cached or expired: call Nominatim ----
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("lat", lat);
    url.searchParams.set("lon", lng);
    url.searchParams.set("format", "json");
    url.searchParams.set("zoom", "10");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "en");

    const nominatimRes = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "world-travel-competition/1.0 (your-email-or-url)",
      },
    });

    if (!nominatimRes.ok) {
      console.error("Nominatim error status:", nominatimRes.status);
      return res.status(502).json({ error: "Geocoding provider error" });
    }

    const data = await nominatimRes.json();
    const addr = data.address || {};

    const cc = (addr.country_code || "").toLowerCase();

    // If you added COUNTRY_NAMES_EN, you can normalize here:
    // const country = COUNTRY_NAMES_EN[cc] || addr.country || null;
    const country = addr.country || null;

    const cityLike =
      addr.city ||
      addr.town ||
      addr.village ||
      addr.hamlet ||
      addr.suburb ||
      addr.neighbourhood ||
      null;

    const stateLike =
      addr.state || addr.region || addr.province || addr.county || null;

    let placeName;

    if (cc === "us" || cc === "ca" || cc === "au") {
      if (cityLike && stateLike && country) {
        placeName = `${cityLike}, ${stateLike}, ${country}`;
      } else if (cityLike && country) {
        placeName = `${cityLike}, ${country}`;
      } else if (stateLike && country) {
        placeName = `${stateLike}, ${country}`;
      } else if (cityLike) {
        placeName = cityLike;
      } else if (country) {
        placeName = country;
      } else {
        placeName = data.display_name || "Unknown location";
      }
    } else {
      if (cityLike && country) {
        placeName = `${cityLike}, ${country}`;
      } else if (cityLike) {
        placeName = cityLike;
      } else if (stateLike && country) {
        placeName = `${stateLike}, ${country}`;
      } else if (country) {
        placeName = country;
      } else {
        placeName = data.display_name || "Unknown location";
      }
    }

    const responsePayload = {
      place_name: placeName,
      country,
      country_code: addr.country_code || null,
      raw: data,
    };

    // ---- 3) Store in cache ----
    reverseGeoCache.set(cacheKey, {
      data: responsePayload,
      expiresAt: now + REVERSE_GEO_TTL_MS,
    });

    // console.log("Reverse-geocode cache store:", cacheKey);

    return res.json(responsePayload);
  } catch (err) {
    console.error("Reverse geocode error:", err);
    return res
      .status(500)
      .json({ error: "Failed to reverse-geocode location" });
  }
});

// ===== CATCH-ALL: Serve index.html for non-API routes =====
app.use((req, res) => {
  // Don't hijack API routes
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "API endpoint not found" });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
