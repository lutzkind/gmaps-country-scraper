#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const config = require("../src/config");
const { createStatusChecker } = require("../src/status-checker");

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error(
      "Usage: npm run backfill-statuses -- /path/to/export.csv [/path/to/another.csv]"
    );
    process.exitCode = 1;
    return;
  }

  const checker = createStatusChecker({ config });
  if (!checker.isConfigured()) {
    throw new Error(
      "No browser executable found. Set STATUS_CHECK_BROWSER_PATH or GOOGLE_CHROME_PATH."
    );
  }

  for (const filePath of files) {
    const absolutePath = path.resolve(filePath);
    const sourceCsv = fs.readFileSync(absolutePath, "utf8");
    const records = parse(sourceCsv, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });

    const targets = records.map((record, index) => ({
      id: index + 1,
      link: record.link,
      placeId: record.place_id || null,
      cid: record.cid || null,
    }));
    const results = await checker.checkLeads(targets, {});
    const byKey = new Map(
      results.map((result) => [
        result.placeId || result.cid || result.link || String(result.leadId),
        result,
      ])
    );

    const enrichedRecords = records.map((record, index) => {
      const key =
        record.place_id || record.cid || record.link || String(index + 1);
      const result = byKey.get(key);
      return {
        ...record,
        recovered_status: result?.status || "",
        status_checked_at: result?.checkedAt || "",
      };
    });
    const filteredRecords = enrichedRecords.filter(
      (record) => record.recovered_status !== "permanently_closed"
    );

    const outputBase = absolutePath.replace(/\.csv$/i, "");
    fs.writeFileSync(
      `${outputBase}.status-backfill.csv`,
      stringify(enrichedRecords, { header: true }),
      "utf8"
    );
    fs.writeFileSync(
      `${outputBase}.filtered.csv`,
      stringify(filteredRecords, { header: true }),
      "utf8"
    );

    console.log(
      JSON.stringify(
        {
          input: absolutePath,
          total: records.length,
          permanentlyClosed: results.filter(
            (result) => result.status === "permanently_closed"
          ).length,
          filteredOutput: `${outputBase}.filtered.csv`,
          backfillOutput: `${outputBase}.status-backfill.csv`,
        },
        null,
        2
      )
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
