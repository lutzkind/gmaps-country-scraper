const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CONSENT_PATTERNS = [
  /accept all/i,
  /alle akzeptieren/i,
  /tout accepter/i,
  /aceptar todo/i,
  /accetta tutto/i,
  /aceitar tudo/i,
];

const STATUS_PATTERNS = [
  { status: "permanently_closed", regex: /\bpermanently closed\b/i },
  { status: "permanently_closed", regex: /\bdauerhaft geschlossen\b/i },
  { status: "permanently_closed", regex: /\bferm[ée] définitivement\b/i },
  { status: "permanently_closed", regex: /\bcerrad[oa] permanentemente\b/i },
  { status: "permanently_closed", regex: /\bchiuso definitivamente\b/i },
  { status: "temporarily_closed", regex: /\btemporarily closed\b/i },
  { status: "temporarily_closed", regex: /\bvorübergehend geschlossen\b/i },
  { status: "temporarily_closed", regex: /\bferm[ée] temporairement\b/i },
  { status: "temporarily_closed", regex: /\bcerrad[oa] temporalmente\b/i },
  { status: "temporarily_closed", regex: /\bchiuso temporaneamente\b/i },
];

const KNOWN_BROWSER_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function createStatusChecker({ config }) {
  return {
    isConfigured() {
      return Boolean(resolveBrowserPath(config));
    },

    async checkLeads(leads, options = {}) {
      if (!Array.isArray(leads) || leads.length === 0) {
        return [];
      }

      const executablePath = resolveBrowserPath({
        ...config,
        statusCheckBrowserPath:
          cleanString(options.browserPath) || config.statusCheckBrowserPath,
      });
      if (!executablePath) {
        throw new Error(
          "No Chromium/Chrome executable found. Set STATUS_CHECK_BROWSER_PATH or GOOGLE_CHROME_PATH."
        );
      }

      const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: [
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--no-sandbox",
          "--disable-setuid-sandbox",
        ],
      });

      try {
        const concurrency = clampInt(
          options.concurrency,
          config.statusCheckConcurrency,
          1,
          8
        );
        const timeoutMs = clampInt(
          options.timeoutMs,
          config.statusCheckTimeoutMs,
          5000,
          120000
        );

        return await mapWithConcurrency(
          leads,
          concurrency,
          async (lead) => {
            try {
              const page = await browser.newPage();
              page.setDefaultNavigationTimeout(timeoutMs);
              page.setDefaultTimeout(timeoutMs);

              try {
                return await checkLead(page, lead, timeoutMs);
              } finally {
                await page.close().catch(() => {});
              }
            } catch (error) {
              return createFailedLeadResult(lead, error);
            }
          }
        );
      } finally {
        await browser.close().catch(() => {});
      }
    },
  };
}

function createFailedLeadResult(lead, error) {
  return {
    leadId: lead?.id || null,
    placeId: lead?.placeId || null,
    cid: lead?.cid || null,
    link: normalizeMapsUrl(lead?.link),
    status: "failed",
    error: error?.message || String(error),
    matchedText: null,
    checkedAt: new Date().toISOString(),
  };
}

async function checkLead(page, lead, timeoutMs) {
  try {
    const resolved = await resolveLead(page, lead, timeoutMs);
    if (!resolved?.link) {
      return {
        leadId: lead?.id || null,
        placeId: lead?.placeId || null,
        cid: lead?.cid || null,
        link: lead?.link || null,
        status: "skipped",
        reason: "Lead has no resolvable Google Maps place link.",
        matchedText: null,
        checkedAt: new Date().toISOString(),
      };
    }

    const bodyText =
      resolved.bodyText || (await openMapsPage(page, resolved.link, timeoutMs));
    if (resolved.resolvedBy !== "provided_link") {
      const validation = await validateResolvedPlace(page, lead, bodyText);
      if (!validation.ok) {
        return {
          leadId: lead?.id || null,
          placeId: lead?.placeId || null,
          cid: lead?.cid || null,
          link: lead?.link || null,
          status: "skipped",
          reason: validation.reason,
          matchedText: null,
          checkedAt: new Date().toISOString(),
          resolvedBy: resolved.resolvedBy,
        };
      }
    }
    const detection = detectStatus(bodyText);

    return {
      leadId: lead?.id || null,
      placeId: lead?.placeId || null,
      cid: lead?.cid || null,
      link: resolved.link,
      status: detection.status,
      matchedText: detection.matchedText,
      checkedAt: new Date().toISOString(),
      reason: detection.status === "open_or_unknown" ? "No closure banner detected." : null,
      resolvedBy: resolved.resolvedBy,
    };
  } catch (error) {
    return {
      leadId: lead?.id || null,
      placeId: lead?.placeId || null,
      cid: lead?.cid || null,
      link: normalizeMapsUrl(lead?.link),
      status: "failed",
      error: error.message,
      matchedText: null,
      checkedAt: new Date().toISOString(),
    };
  }
}

async function resolveLead(page, lead, timeoutMs) {
  const directLink = normalizeMapsUrl(lead?.link);
  if (directLink) {
    return {
      link: directLink,
      resolvedBy: "provided_link",
      bodyText: null,
    };
  }

  for (const query of buildSearchQueries(lead)) {
    const searchUrl = new URL("https://www.google.com/maps/search/");
    searchUrl.searchParams.set("api", "1");
    searchUrl.searchParams.set("query", query);
    searchUrl.searchParams.set("hl", "en");
    searchUrl.searchParams.set("authuser", "0");

    const bodyText = await openMapsPage(page, searchUrl.toString(), timeoutMs);
    const directResult = normalizeMapsUrl(page.url());
    if (isPlaceUrl(directResult)) {
      return {
        link: directResult,
        resolvedBy: "maps_search_redirect",
        bodyText,
      };
    }

    const candidate = await extractCandidatePlaceUrl(page);
    if (candidate) {
      return {
        link: candidate,
        resolvedBy: "maps_search_result",
        bodyText: null,
      };
    }
  }

  return null;
}

async function openMapsPage(page, url, timeoutMs) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });

  await acceptConsentIfPresent(page);
  await page.waitForFunction(() => document.body && document.body.innerText.length > 0, {
    timeout: Math.min(timeoutMs, 10000),
  }).catch(() => {});
  await delay(750);
  return page.evaluate(() => document.body?.innerText || "");
}

async function extractCandidatePlaceUrl(page) {
  const href = await page.evaluate(() => {
    const selectors = [
      'a[href*="/maps/place/"]',
      'a[href*="google.com/maps/place/"]',
      'a[href*="/maps?cid="]',
    ];

    for (const selector of selectors) {
      const matches = Array.from(document.querySelectorAll(selector))
        .map((anchor) => anchor.href || anchor.getAttribute("href") || "")
        .map((value) => value.trim())
        .filter(Boolean);
      if (matches.length > 0) {
        return matches[0];
      }
    }

    return null;
  });

  return normalizeMapsUrl(href);
}

async function acceptConsentIfPresent(page) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  if (!/consent/i.test(title) && !/consent\.google/.test(url)) {
    return;
  }

  const clicked = await page.evaluate((patterns) => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const serialized = patterns.map((pattern) => new RegExp(pattern.source, pattern.flags));
    const match = buttons.find((button) =>
      serialized.some((pattern) => pattern.test(button.innerText || ""))
    );
    if (!match) {
      return false;
    }
    match.click();
    return true;
  }, CONSENT_PATTERNS.map((pattern) => ({
    source: pattern.source,
    flags: pattern.flags,
  })));

  if (clicked) {
    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: 10000,
    }).catch(() => {});
  }
}

function detectStatus(text) {
  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
  for (const pattern of STATUS_PATTERNS) {
    const match = normalizedText.match(pattern.regex);
    if (match) {
      return {
        status: pattern.status,
        matchedText: match[0],
      };
    }
  }

  return {
    status: "open_or_unknown",
    matchedText: null,
  };
}

function buildSearchQueries(lead) {
  const name = cleanString(lead?.name);
  if (!name) {
    return [];
  }

  const address = cleanString(lead?.address);
  const phone = cleanString(lead?.phone);
  const queries = [];

  if (address || phone) {
    queries.push([name, address, phone].filter(Boolean).join(" "));
    if (address) {
      queries.push([name, address].filter(Boolean).join(" "));
    }
    if (phone) {
      queries.push([name, phone].filter(Boolean).join(" "));
    }
  } else {
    queries.push(name);
  }

  return [...new Set(queries.map(cleanString).filter(Boolean))];
}

async function validateResolvedPlace(page, lead, bodyText) {
  const leadName = cleanString(lead?.name);
  if (!leadName) {
    return { ok: false, reason: "Lead has no name to validate the resolved place." };
  }

  const details = await page.evaluate(() => {
    const heading =
      document.querySelector("h1")?.textContent ||
      document.querySelector('[role="main"] h1')?.textContent ||
      "";
    return {
      title: document.title || "",
      heading: heading || "",
      url: window.location.href || "",
    };
  });

  const placeName = cleanString(details.heading) || extractPlaceNameFromTitle(details.title);
  const body = normalizeForMatch(bodyText);
  const nameCheck = evaluateNameMatch(leadName, placeName, body);
  if (!nameCheck.ok) {
    return { ok: false, reason: nameCheck.reason };
  }

  const corroboration = evaluateCorroboration(lead, body);
  if (!corroboration.ok) {
    return { ok: false, reason: corroboration.reason };
  }

  return {
    ok: true,
    matchedName: placeName,
    resolvedUrl: details.url,
  };
}

function extractPlaceNameFromTitle(title) {
  const normalized = cleanString(title);
  if (!normalized) {
    return null;
  }

  const firstSegment = normalized.split(" - ").map(cleanString).find(Boolean);
  return firstSegment || normalized;
}

function evaluateNameMatch(leadName, placeName, bodyText) {
  const normalizedLeadName = normalizeForMatch(leadName);
  const normalizedPlaceName = normalizeForMatch(placeName);

  if (normalizedPlaceName) {
    if (
      normalizedPlaceName.includes(normalizedLeadName) ||
      normalizedLeadName.includes(normalizedPlaceName)
    ) {
      return { ok: true };
    }
  }

  const leadTokens = tokenizeName(leadName);
  if (leadTokens.length === 0) {
    return { ok: false, reason: "Resolved place name could not be validated." };
  }

  const searchableText = [normalizedPlaceName, bodyText].filter(Boolean).join(" ");
  const matchedTokens = leadTokens.filter((token) => searchableText.includes(token));
  const coverage = matchedTokens.length / leadTokens.length;

  if (matchedTokens.length >= Math.min(2, leadTokens.length) && coverage >= 0.75) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "Resolved Google Maps place did not match the original lead name closely enough.",
  };
}

function evaluateCorroboration(lead, bodyText) {
  const phone = cleanString(lead?.phone);
  const address = cleanString(lead?.address);
  if (!phone && !address) {
    return {
      ok: false,
      reason: "Lead has no phone or address to corroborate a recovered Google Maps link.",
    };
  }

  const checks = [];
  if (phone) {
    checks.push(matchPhone(phone, bodyText));
  }
  if (address) {
    checks.push(matchAddress(address, bodyText));
  }

  if (checks.some((check) => check.ok)) {
    return { ok: true };
  }

  const reason = checks.map((check) => check.reason).filter(Boolean)[0];
  return {
    ok: false,
    reason: reason || "Resolved Google Maps place lacked corroborating phone/address details.",
  };
}

function matchPhone(phone, bodyText) {
  const digits = normalizeDigits(phone);
  if (!digits || digits.length < 7) {
    return { ok: false, reason: "Lead phone could not be normalized for validation." };
  }

  const bodyDigits = normalizeDigits(bodyText);
  if (bodyDigits.includes(digits)) {
    return { ok: true };
  }

  if (digits.length > 10 && bodyDigits.includes(digits.slice(-10))) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "Resolved Google Maps place did not expose the expected phone number.",
  };
}

function matchAddress(address, bodyText) {
  const normalizedBody = normalizeForMatch(bodyText);
  const signals = extractAddressSignals(address);
  const matchedSignals = signals.filter((signal) => normalizedBody.includes(signal));

  if (matchedSignals.length >= Math.min(2, signals.length)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "Resolved Google Maps place did not expose enough matching address details.",
  };
}

function extractAddressSignals(address) {
  const normalized = normalizeForMatch(address);
  const parts = address
    .split(",")
    .map((part) => normalizeForMatch(part))
    .filter(Boolean);
  const streetNumber = normalized.match(/\b\d+[a-z]?\b/i)?.[0] || null;
  const postcode =
    normalizeForMatch(
      address.match(/\b[A-Z0-9][A-Z0-9 -]{2,9}[A-Z0-9]\b/i)?.[0] || ""
    ) || null;
  const city = parts[1] || null;

  return [...new Set([streetNumber, postcode, city].filter(Boolean))];
}

function tokenizeName(value) {
  const stopWords = new Set([
    "and",
    "bar",
    "cafe",
    "co",
    "company",
    "food",
    "grill",
    "inc",
    "llc",
    "restaurant",
    "the",
  ]);
  const normalized = normalizeForMatch(value);
  const tokens = normalized
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token));
  return tokens.length > 0
    ? tokens
    : normalized.split(/\s+/).filter((token) => token.length >= 3);
}

function normalizeForMatch(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function normalizeMapsUrl(value) {
  const raw = cleanString(value);
  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw, "https://www.google.com");
    if (!/google\.[^/]+$/.test(url.hostname) && url.hostname !== "www.google.com") {
      return null;
    }

    if (!url.searchParams.has("hl")) {
      url.searchParams.set("hl", "en");
    }
    if (!url.searchParams.has("authuser")) {
      url.searchParams.set("authuser", "0");
    }

    return url.toString();
  } catch {
    return null;
  }
}

function isPlaceUrl(value) {
  const url = cleanString(value);
  return Boolean(url && /\/maps\/place\//.test(url));
}

function resolveBrowserPath(config) {
  const configured = cleanString(config.statusCheckBrowserPath);
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  return KNOWN_BROWSER_PATHS.find((candidate) => fs.existsSync(candidate)) || null;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length || 1) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          break;
        }
        results[index] = await worker(items[index], index);
      }
    }
  );

  await Promise.all(runners);
  return results;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function cleanString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  buildSearchQueries,
  createStatusChecker,
  detectStatus,
  isPlaceUrl,
  normalizeMapsUrl,
};
