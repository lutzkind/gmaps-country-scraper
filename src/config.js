const path = require("path");

function intFromEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatFromEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFromEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function arrayFromEnv(name, fallback = []) {
  const value = process.env[name];
  if (value == null || value === "") {
    return fallback;
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
const port = intFromEnv("PORT", 3000);
const workerPollMs = intFromEnv("WORKER_POLL_MS", 5000);
const runningShardStaleMs = intFromEnv(
  "RUNNING_SHARD_STALE_MS",
  Math.max(workerPollMs * 24, 30 * 60 * 1000)
);

module.exports = {
  host: process.env.HOST || "0.0.0.0",
  port,
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, "gmaps-country-scraper.db"),
  exportsDir: process.env.EXPORTS_DIR || path.join(dataDir, "exports"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
  userAgent:
    process.env.USER_AGENT ||
    "gmaps-country-scraper/1.0 (+mailto:lutz.kind96@gmail.com)",
  nominatimUrl:
    process.env.NOMINATIM_URL ||
    "https://nominatim.openstreetmap.org/search",
  workerPollMs,
  runningShardStaleMs,
  // Maximum subdivision depth. At depth 14 the US bbox produces cells of
  // ~1.85 km × 0.59 km (~1.1 km²), which keeps restaurant counts per cell
  // below Google Maps' effective ~120-result cap even in Manhattan-level
  // density (~85 restaurants/km²). Sparse cells return 0 at depth 11-12
  // and terminate without cascading, so the cost is proportional to actual
  // density rather than exponential across the whole country.
  maxShardDepth: intFromEnv("MAX_SHARD_DEPTH", 14),
  retryLimit: intFromEnv("RETRY_LIMIT", 6),
  retryBaseDelayMs: intFromEnv("RETRY_BASE_DELAY_MS", 60000),
  resultSplitThreshold: intFromEnv("RESULT_SPLIT_THRESHOLD", 18),
  // Must be well below the cell width at MAX_SHARD_DEPTH to prevent
  // canSplitBBox() from returning false before the depth limit is reached.
  // US bbox width at depth 14 = 360/2^14 ≈ 0.022°; height ≈ 0.0053°.
  // Using 0.002° gives safe headroom through depth 14 and beyond.
  minShardWidthDeg: floatFromEnv("MIN_SHARD_WIDTH_DEG", 0.002),
  minShardHeightDeg: floatFromEnv("MIN_SHARD_HEIGHT_DEG", 0.002),
  adminUsername: process.env.ADMIN_USERNAME || null,
  adminPassword: process.env.ADMIN_PASSWORD || null,
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "gmaps_scraper_session",
  sessionTtlHours: intFromEnv("SESSION_TTL_HOURS", 24),
  googleMapsBinary: process.env.GOOGLE_MAPS_BINARY || "google-maps-scraper",
  googleMapsFastMode: boolFromEnv("GMAPS_FAST_MODE", true),
  googleMapsDepth: intFromEnv("GMAPS_DEPTH", 2),
  googleMapsLeafDepth: intFromEnv("GMAPS_LEAF_DEPTH", 10),
  googleMapsComprehensiveDepth: intFromEnv("GMAPS_COMPREHENSIVE_DEPTH", 10),
  googleMapsConcurrency: intFromEnv("GMAPS_CONCURRENCY", 1),
  googleMapsRadiusCapMeters: intFromEnv("GMAPS_RADIUS_CAP_METERS", 45000),
  googleMapsTargetShardRadiusMeters: intFromEnv(
    "GMAPS_TARGET_SHARD_RADIUS_METERS",
    15000
  ),
  googleMapsExitOnInactivity:
    process.env.GMAPS_EXIT_ON_INACTIVITY || "90s",
  // Hard kill timeout for the scraper binary. Guards against frozen processes
  // that ignore -exit-on-inactivity and would lock the worker's busy flag.
  // Defaults to 80% of runningShardStaleMs so the process is killed before
  // the stale-shard reclaim window expires.
  googleMapsBinaryTimeoutMs: intFromEnv(
    "GMAPS_BINARY_TIMEOUT_MS",
    Math.floor(runningShardStaleMs * 0.8)
  ),
  nocoDb: {
    baseUrl: process.env.NOCODB_BASE_URL || null,
    apiToken: process.env.NOCODB_API_TOKEN || null,
    baseId: process.env.NOCODB_BASE_ID || null,
    tableId: process.env.NOCODB_TABLE_ID || null,
    autoSyncOnCompletion: boolFromEnv("NOCODB_AUTO_SYNC_ON_COMPLETION", false),
    autoSyncIntervalMinutes: intFromEnv("NOCODB_AUTO_SYNC_INTERVAL_MINUTES", 30),
    autoCreateColumns: boolFromEnv("NOCODB_AUTO_CREATE_COLUMNS", true),
  },
};
