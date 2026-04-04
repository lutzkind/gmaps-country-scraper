function normalizeKeyword(value) {
  const keyword = String(value || "").trim();
  if (!keyword) {
    const error = new Error("keyword is required.");
    error.statusCode = 400;
    throw error;
  }

  return keyword;
}

function normalizeProxyList(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((value) => String(value || "").trim()).filter(Boolean))];
  }

  return [
    ...new Set(
      String(input || "")
        .split(/[\n,]+/)
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

function normalizeComprehensiveMode(value) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function resolveSearchParams(keyword, options = {}) {
  return {
    query: normalizeKeyword(keyword),
    proxies: normalizeProxyList(options.proxies),
    comprehensiveMode: normalizeComprehensiveMode(options.comprehensiveMode),
  };
}

module.exports = {
  normalizeComprehensiveMode,
  normalizeProxyList,
  normalizeKeyword,
  resolveSearchParams,
};
