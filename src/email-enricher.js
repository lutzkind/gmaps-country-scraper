const CONTACT_PATH_HINTS = [
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
  "/team",
  "/support",
  "/help",
  "/impressum",
  "/imprint",
  "/legal",
];

const CONTACT_LINK_HINT = /(contact|about|team|support|help|impressum|imprint|legal|company|staff)/i;
const EMAIL_REGEX = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}\b/gi;
const SOCIAL_HOSTS = [
  ["facebook", ["facebook.com"]],
  ["instagram", ["instagram.com"]],
  ["linkedin", ["linkedin.com"]],
  ["x", ["x.com", "twitter.com"]],
  ["youtube", ["youtube.com", "youtu.be"]],
  ["tiktok", ["tiktok.com"]],
  ["telegram", ["t.me", "telegram.me", "telegram.org"]],
  ["whatsapp", ["wa.me", "whatsapp.com"]],
  ["github", ["github.com"]],
  ["crunchbase", ["crunchbase.com"]],
];

function createEmailEnricher({ config }) {
  return {
    isConfigured() {
      return Boolean(cleanString(config.crawl4aiBaseUrl));
    },

    async scrapeUrls(urls, options = {}) {
      const limit = clampInt(
        options.concurrency,
        config.emailEnrichmentConcurrency,
        1,
        10
      );
      const normalized = urls
        .map((url) => normalizeWebsiteUrl(url))
        .filter(Boolean);

      return mapWithConcurrency(normalized, limit, (url) =>
        scrapeWebsite(url, config, options)
      );
    },

    async enrichLead(lead, options = {}) {
      if (!cleanString(lead?.website)) {
        return {
          leadId: lead?.id || null,
          website: lead?.website || null,
          status: "skipped",
          reason: "Lead has no website.",
          emails: [],
          socialLinks: {},
          crawledUrls: [],
        };
      }

      const result = await scrapeWebsite(lead.website, config, options);
      return {
        leadId: lead.id,
        ...result,
      };
    },
  };
}

async function scrapeWebsite(inputUrl, config, options = {}) {
  const website = normalizeWebsiteUrl(inputUrl);
  if (!website) {
    return {
      input: inputUrl,
      website: null,
      status: "failed",
      error: "Invalid website URL.",
      emails: [],
      socialLinks: {},
      crawledUrls: [],
    };
  }

  const maxPages = clampInt(
    options.maxPagesPerSite,
    config.emailEnrichmentMaxPages,
    1,
    20
  );
  const queue = buildSeedQueue(website, maxPages);
  const queued = new Set(queue);
  const crawledUrls = [];
  const emailOrder = [];
  const emailSet = new Set();
  const socialLinks = {};
  let firstError = null;
  let contactPageUrl = null;

  while (queue.length > 0 && crawledUrls.length < maxPages) {
    const currentUrl = queue.shift();
    let html = "";

    try {
      html = await fetchHtml(currentUrl, config, options);
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
      continue;
    }

    crawledUrls.push(currentUrl);
    const extracted = extractContactsFromHtml(html, currentUrl, website);

    for (const email of extracted.emails) {
      if (!emailSet.has(email)) {
        emailSet.add(email);
        emailOrder.push(email);
      }
    }

    for (const [network, link] of Object.entries(extracted.socialLinks)) {
      if (!socialLinks[network]) {
        socialLinks[network] = link;
      }
    }

    if (!contactPageUrl && extracted.contactPageUrl) {
      contactPageUrl = extracted.contactPageUrl;
    }

    for (const nextUrl of extracted.contactLinks) {
      if (queued.has(nextUrl) || crawledUrls.includes(nextUrl)) {
        continue;
      }
      if (queued.size >= maxPages * 3) {
        break;
      }
      queued.add(nextUrl);
      queue.push(nextUrl);
    }
  }

  const primaryEmail = emailOrder[0] || null;
  return {
    input: inputUrl,
    website,
    status:
      primaryEmail || Object.keys(socialLinks).length > 0
        ? "ok"
        : firstError && crawledUrls.length === 0
          ? "failed"
          : "no_contacts",
    error:
      primaryEmail ||
      Object.keys(socialLinks).length > 0 ||
      !firstError ||
      crawledUrls.length > 0
        ? null
        : firstError.message,
    emails: emailOrder,
    primaryEmail,
    emailSource: primaryEmail ? "website_crawl" : null,
    contactPageUrl,
    socialLinks,
    crawledUrls,
    pageCount: crawledUrls.length,
  };
}

async function fetchHtml(url, config, options) {
  const controller = new AbortController();
  const timeoutMs = clampInt(
    options.timeoutMs,
    config.emailEnrichmentTimeoutMs,
    1000,
    120000
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.crawl4aiBaseUrl.replace(/\/+$/, "")}/html`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(cleanString(config.crawl4aiBearerToken)
          ? { Authorization: `Bearer ${config.crawl4aiBearerToken}` }
          : {}),
      },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Crawl4AI returned ${response.status} for ${url}.`
      );
    }

    const payload = await response.json();
    const html = cleanString(payload.html) || cleanString(payload.cleaned_html);
    if (!html) {
      throw new Error(`Crawl4AI returned no HTML for ${url}.`);
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

function extractContactsFromHtml(html, pageUrl, rootUrl) {
  const emails = [];
  const emailSet = new Set();
  const socialLinks = {};
  const contactLinks = [];
  const contactLinkSet = new Set();
  let contactPageUrl = null;

  for (const email of extractEmails(html)) {
    if (!emailSet.has(email)) {
      emailSet.add(email);
      emails.push(email);
    }
  }

  const hrefRegex = /href\s*=\s*["']([^"'#]+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html))) {
    const href = decodeHtmlEntities(match[1]);
    if (!href) {
      continue;
    }

    if (href.toLowerCase().startsWith("mailto:")) {
      for (const email of extractEmails(href)) {
        if (!emailSet.has(email)) {
          emailSet.add(email);
          emails.push(email);
        }
      }
      if (!contactPageUrl) {
        contactPageUrl = pageUrl;
      }
      continue;
    }

    const resolved = resolveUrl(href, pageUrl);
    if (!resolved) {
      continue;
    }

    const network = detectSocialNetwork(resolved);
    if (network && !socialLinks[network]) {
      socialLinks[network] = resolved;
    }

    if (
      isSameSite(resolved, rootUrl) &&
      CONTACT_LINK_HINT.test(resolved) &&
      !isAssetUrl(resolved) &&
      !contactLinkSet.has(resolved)
    ) {
      contactLinkSet.add(resolved);
      contactLinks.push(resolved);
      if (!contactPageUrl) {
        contactPageUrl = resolved;
      }
    }
  }

  return {
    emails,
    socialLinks,
    contactLinks,
    contactPageUrl,
  };
}

function buildSeedQueue(website, maxPages) {
  const queue = [];
  const queued = new Set();
  const root = normalizeWebsiteUrl(website);
  if (!root) {
    return queue;
  }

  queue.push(root);
  queued.add(root);

  for (const suffix of CONTACT_PATH_HINTS) {
    if (queue.length >= maxPages) {
      break;
    }
    const candidate = new URL(suffix, root).toString();
    if (!queued.has(candidate)) {
      queued.add(candidate);
      queue.push(candidate);
    }
  }

  return queue;
}

function extractEmails(value) {
  const matches = String(value || "").match(EMAIL_REGEX) || [];
  return [
    ...new Set(
      matches
        .map((email) => normalizeEmail(email))
        .filter(Boolean)
    ),
  ];
}

function normalizeEmail(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^mailto:/i, "")
    .replace(/[)>.,;:'"\]]+$/g, "")
    .toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return null;
  }

  const [localPart, domain] = normalized.split("@");
  if (!localPart || !domain || !domain.includes(".")) {
    return null;
  }

  if (
    /^(example\.com|yourdomain\.com|domain\.com)$/i.test(domain) ||
    /^(email|name|yourname)$/i.test(localPart)
  ) {
    return null;
  }

  return normalized;
}

function detectSocialNetwork(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [network, hosts] of SOCIAL_HOSTS) {
      if (hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) {
        return network;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveUrl(value, baseUrl) {
  try {
    const resolved = new URL(value, baseUrl);
    if (!["http:", "https:"].includes(resolved.protocol)) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

function isSameSite(candidateUrl, rootUrl) {
  try {
    const candidate = new URL(candidateUrl);
    const root = new URL(rootUrl);
    return normalizeHost(candidate.hostname) === normalizeHost(root.hostname);
  } catch {
    return false;
  }
}

function normalizeHost(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function normalizeWebsiteUrl(value) {
  const trimmed = cleanString(value);
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isAssetUrl(url) {
  return /\.(?:pdf|jpg|jpeg|png|gif|svg|webp|css|js|xml|zip|mp4|mp3)(?:[?#].*)?$/i.test(url);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#x3A;/gi, ":")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        break;
      }
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
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

module.exports = {
  createEmailEnricher,
};
