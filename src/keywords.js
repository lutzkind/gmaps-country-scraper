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

function resolveSearchParams(keyword, options = {}) {
  return {
    query: normalizeKeyword(keyword),
    proxies: normalizeProxyList(options.proxies),
  };
}

module.exports = {
  normalizeProxyList,
  normalizeKeyword,
  resolveSearchParams,
};
