// db.js
const { Pool } = require("pg");

const isProd = process.env.NODE_ENV === "production";

// For Supabase, SSL is recommended; in dev we can still be lenient
const ssl = isProd
  ? { rejectUnauthorized: false } // Supabase uses trusted CAs; this is usually enough
  : { rejectUnauthorized: false }; // dev: same, to avoid any local TLS weirdness

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};
