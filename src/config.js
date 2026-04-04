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

module.exports = {
  host: process.env.HOST || "0.0.0.0",
  port: intFromEnv("PORT", 3000),
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
  workerPollMs: intFromEnv("WORKER_POLL_MS", 5000),
  maxShardDepth: intFromEnv("MAX_SHARD_DEPTH", 10),
  retryLimit: intFromEnv("RETRY_LIMIT", 6),
  retryBaseDelayMs: intFromEnv("RETRY_BASE_DELAY_MS", 60000),
  resultSplitThreshold: intFromEnv("RESULT_SPLIT_THRESHOLD", 18),
  minShardWidthDeg: floatFromEnv("MIN_SHARD_WIDTH_DEG", 0.05),
  minShardHeightDeg: floatFromEnv("MIN_SHARD_HEIGHT_DEG", 0.05),
  adminUsername: process.env.ADMIN_USERNAME || null,
  adminPassword: process.env.ADMIN_PASSWORD || null,
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "gmaps_scraper_session",
  sessionTtlHours: intFromEnv("SESSION_TTL_HOURS", 24),
  googleMapsBinary: process.env.GOOGLE_MAPS_BINARY || "google-maps-scraper",
  googleMapsFastMode: boolFromEnv("GMAPS_FAST_MODE", true),
  googleMapsDepth: intFromEnv("GMAPS_DEPTH", 2),
  googleMapsComprehensiveDepth: intFromEnv("GMAPS_COMPREHENSIVE_DEPTH", 10),
  googleMapsConcurrency: intFromEnv("GMAPS_CONCURRENCY", 1),
  googleMapsRadiusCapMeters: intFromEnv("GMAPS_RADIUS_CAP_METERS", 45000),
  googleMapsTargetShardRadiusMeters: intFromEnv(
    "GMAPS_TARGET_SHARD_RADIUS_METERS",
    15000
  ),
  googleMapsExitOnInactivity:
    process.env.GMAPS_EXIT_ON_INACTIVITY || "90s",
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
