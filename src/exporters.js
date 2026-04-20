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
  const job = store.getJob(jobId);
  const leads = store.getJobLeads(jobId, { limit: 1000000000, offset: 0 });
  const targetDir = path.join(config.exportsDir, jobId);
  fs.mkdirSync(targetDir, { recursive: true });

  const csvPath = path.join(targetDir, "leads.csv");
  const jsonPath = path.join(targetDir, "leads.json");

  const headers = [
    "query_name",
    "source",
    "country",
    "city",
    "area",
    "state_region",
    "postcode",
    "lead_country",
    "name",
    "category",
    "subcategory",
    "all_subcategories",
    "website",
    "phone",
    "email",
    "all_emails",
    "email_source",
    "contact_page_url",
    "social_links_json",
    "address",
    "review_count",
    "review_rating",
    "status",
    "price_range",
    "place_id",
    "cid",
    "data_id",
    "link",
  ];

  const rows = leads.map((lead) => ({
    queryName: job?.keyword || "",
    source: lead.source || "gmaps",
    country: job?.country || "",
    name: lead.name,
    category: lead.category,
    subcategory: lead.subcategory,
    allSubcategories: Array.isArray(lead.allSubcategories)
      ? lead.allSubcategories.join(" | ")
      : "",
    website: lead.website,
    phone: lead.phone,
    email: lead.email,
    allEmails: Array.isArray(lead.emails) ? lead.emails.join(" | ") : "",
    emailSource: lead.emailSource,
    contactPageUrl: lead.contactPageUrl,
    socialLinksJson: JSON.stringify(lead.socialLinks || {}),
    address: lead.address,
    city: lead.city,
    area: lead.area,
    stateRegion: lead.stateRegion,
    postcode: lead.postcode,
    leadCountry: lead.country,
    reviewCount: lead.reviewCount,
    reviewRating: lead.reviewRating,
    status: lead.status,
    priceRange: lead.priceRange,
    placeId: lead.placeId,
    cid: lead.cid,
    dataId: lead.dataId,
    link: lead.link,
  }));

  const csvLines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.queryName,
        row.source,
        row.country,
        row.city,
        row.area,
        row.stateRegion,
        row.postcode,
        row.leadCountry,
        row.name,
        row.category,
        row.subcategory,
        row.allSubcategories,
        row.website,
        row.phone,
        row.email,
        row.allEmails,
        row.emailSource,
        row.contactPageUrl,
        row.socialLinksJson,
        row.address,
        row.reviewCount,
        row.reviewRating,
        row.status,
        row.priceRange,
        row.placeId,
        row.cid,
        row.dataId,
        row.link,
      ]
        .map(escapeCsv)
        .join(",")
    ),
  ];

  fs.writeFileSync(csvPath, `${csvLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2), "utf8");

  return { csvPath, jsonPath };
}

module.exports = {
  writeArtifacts,
};
