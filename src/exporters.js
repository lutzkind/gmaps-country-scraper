const fs = require("fs");
const path = require("path");

function escapeCsv(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeArtifacts(store, config, jobId) {
  const leads = store.getJobLeads(jobId, { limit: 1000000000, offset: 0 });
  const targetDir = path.join(config.exportsDir, jobId);
  fs.mkdirSync(targetDir, { recursive: true });

  const csvPath = path.join(targetDir, "leads.csv");
  const jsonPath = path.join(targetDir, "leads.json");

  const headers = [
    "place_id",
    "cid",
    "data_id",
    "name",
    "category",
    "categories",
    "website",
    "phone",
    "email",
    "address",
    "lat",
    "lon",
    "review_count",
    "review_rating",
    "status",
    "price_range",
    "link",
  ];

  const csvLines = [
    headers.join(","),
    ...leads.map((lead) =>
      [
        lead.placeId,
        lead.cid,
        lead.dataId,
        lead.name,
        lead.category,
        Array.isArray(lead.categories) ? lead.categories.join(" | ") : "",
        lead.website,
        lead.phone,
        lead.email,
        lead.address,
        lead.lat,
        lead.lon,
        lead.reviewCount,
        lead.reviewRating,
        lead.status,
        lead.priceRange,
        lead.link,
      ]
        .map(escapeCsv)
        .join(",")
    ),
  ];

  fs.writeFileSync(csvPath, `${csvLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(leads, null, 2), "utf8");

  return { csvPath, jsonPath };
}

module.exports = {
  writeArtifacts,
};
