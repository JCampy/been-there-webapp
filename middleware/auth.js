// middleware/auth.js
const jwt = require("jsonwebtoken");

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!SUPABASE_JWT_SECRET) {
  console.warn(
    "WARNING: SUPABASE_JWT_SECRET is not set. Auth will not work correctly."
  );
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  try {
    const decoded = jwt.verify(token, SUPABASE_JWT_SECRET);

    // Supabase user id is typically in `sub`
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      // you can add more fields if you want
    };

    next();
  } catch (err) {
    console.error("JWT verify error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = { authenticateToken };
