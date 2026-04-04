const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { parseBoundingBox, bboxCenter, bboxRadiusMeters, pointInsideBBox, pointInsideGeometry } = require("./geo");

async function resolveCountry(country, config) {
  const url = new URL(config.nominatimUrl);
  url.searchParams.set("q", country);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("polygon_geojson", "1");

  const response = await fetch(url, {
    headers: {
      "User-Agent": config.userAgent,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve country "${country}" (${response.status}).`);
  }

  const payload = await response.json();
  const [match] = Array.isArray(payload) ? payload : [];
  if (!match) {
    throw new Error(`Country "${country}" could not be resolved.`);
  }

  return {
    displayName: match.display_name || country,
    countryCode: String(match.address?.country_code || "").toUpperCase(),
    bbox: parseBoundingBox(match.boundingbox),
    geometry: match.geojson ? { type: "Feature", geometry: match.geojson } : null,
  };
}

async function queryGoogleMaps({ job, shard, geometry, config }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gmaps-country-"));
  const outputPath = path.join(tempDir, "results.json");
  const inputPath = path.join(tempDir, "queries.txt");
  const center = bboxCenter(shard.bbox);
  const radiusMeters = Math.max(
    1000,
    bboxRadiusMeters(shard.bbox, config.googleMapsRadiusCapMeters)
  );
  const proxy = selectProxy(job.searchParams?.proxies || [], shard.attemptCount);

  try {
    await fs.writeFile(inputPath, `${job.searchParams?.query || job.keyword}\n`, "utf8");

    const args = [
      "-input",
      inputPath,
      "-results",
      outputPath,
      "-json",
      "-geo",
      `${center.lat},${center.lon}`,
      "-radius",
      String(radiusMeters),
      "-depth",
      String(Math.max(1, config.googleMapsDepth)),
      "-c",
      String(Math.max(1, config.googleMapsConcurrency)),
      "-exit-on-inactivity",
      config.googleMapsExitOnInactivity,
    ];

    if (config.googleMapsFastMode) {
      args.push("-fast-mode");
    }

    if (proxy) {
      args.push("-proxies", proxy);
    }

    await runBinary(config.googleMapsBinary, args, {
      cwd: tempDir,
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root",
      },
    });

    const parsed = await readResults(outputPath);
    const leads = parsed
      .map((entry) => normalizeEntry(entry, shard.bbox))
      .filter(Boolean)
      .filter((lead) => pointInsideBBox(lead.lat, lead.lon, shard.bbox))
      .filter((lead) =>
        geometry ? pointInsideGeometry(lead.lat, lead.lon, geometry) : true
      );

    return {
      rawCount: parsed.length,
      leads,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function selectProxy(proxies, attemptCount) {
  if (!proxies.length) {
    return null;
  }

  const index = Math.max(0, (attemptCount || 1) - 1) % proxies.length;
  return proxies[index];
}

function runBinary(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      reject(new Error(output || `google-maps-scraper exited with code ${code}.`));
    });
  });
}

async function readResults(outputPath) {
  const raw = await fs.readFile(outputPath, "utf8");
  if (!raw.trim()) {
    return [];
  }

  try {
    const payload = JSON.parse(raw);
    if (Array.isArray(payload)) {
      return payload;
    }
    if (Array.isArray(payload?.results)) {
      return payload.results;
    }
    if (Array.isArray(payload?.places)) {
      return payload.places;
    }
  } catch {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  return [];
}

function normalizeEntry(entry, bbox) {
  const lat = toFiniteNumber(entry.latitude);
  const lon = toFiniteNumber(entry.longtitude ?? entry.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const categories = Array.isArray(entry.categories)
    ? entry.categories.filter(Boolean)
    : [];
  const emails = Array.isArray(entry.emails)
    ? entry.emails.filter(Boolean)
    : [];

  return {
    dedupeKey:
      stringValue(entry.place_id) ||
      stringValue(entry.cid) ||
      stringValue(entry.data_id) ||
      stringValue(entry.link) ||
      `${stringValue(entry.title) || "unknown"}:${lat}:${lon}`,
    placeId: stringValue(entry.place_id),
    cid: stringValue(entry.cid),
    dataId: stringValue(entry.data_id),
    link: stringValue(entry.link),
    name: stringValue(entry.title),
    category: stringValue(entry.category),
    categories,
    website: stringValue(entry.website ?? entry.web_site),
    phone: stringValue(entry.phone),
    email: emails[0] || null,
    emails,
    address: stringValue(entry.address),
    completeAddress: entry.complete_address || null,
    lat,
    lon,
    reviewCount: toInteger(entry.review_count),
    reviewRating: toFiniteNumber(entry.review_rating),
    status: stringValue(entry.status),
    priceRange: stringValue(entry.price_range),
    bbox,
    raw: entry,
  };
}

function stringValue(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function toFiniteNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  normalizeEntry,
  queryGoogleMaps,
  resolveCountry,
};
