#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const { createStatusChecker } = require('../src/status-checker');

function parseArgs(argv) {
  const options = {
    startId: 0,
    limit: null,
    batchSize: 25,
    updateBatchSize: 50,
    concurrency: config.statusCheckConcurrency,
    timeoutMs: config.statusCheckTimeoutMs,
    checkpointPath: path.join(config.dataDir, 'nocodb-status-backfill.checkpoint.json'),
    reportPath: path.join(config.dataDir, 'nocodb-status-backfill.report.json'),
    failuresPath: path.join(config.dataDir, 'nocodb-status-backfill.failures.jsonl'),
    closedCsvPath: path.join(config.dataDir, 'nocodb-status-backfill.closed.csv'),
    query: 'gmaps',
    resume: true,
    revalidateLinklessRecoveries: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    switch (token) {
      case '--start-id':
        options.startId = toInt(next, options.startId);
        index += 1;
        break;
      case '--limit':
        options.limit = toInt(next, options.limit);
        index += 1;
        break;
      case '--batch-size':
        options.batchSize = toInt(next, options.batchSize);
        index += 1;
        break;
      case '--update-batch-size':
        options.updateBatchSize = toInt(next, options.updateBatchSize);
        index += 1;
        break;
      case '--concurrency':
        options.concurrency = toInt(next, options.concurrency);
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = toInt(next, options.timeoutMs);
        index += 1;
        break;
      case '--checkpoint':
        options.checkpointPath = next;
        index += 1;
        break;
      case '--report':
        options.reportPath = next;
        index += 1;
        break;
      case '--failures':
        options.failuresPath = next;
        index += 1;
        break;
      case '--closed-csv':
        options.closedCsvPath = next;
        index += 1;
        break;
      case '--query':
        options.query = next || options.query;
        index += 1;
        break;
      case '--no-resume':
        options.resume = false;
        break;
      case '--revalidate-linkless-recoveries':
        options.revalidateLinklessRecoveries = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadCheckpoint(checkpointPath) {
  try {
    const raw = fs.readFileSync(checkpointPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function saveCheckpoint(checkpointPath, state) {
  ensureParentDirectory(checkpointPath);
  fs.writeFileSync(checkpointPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function appendJsonLine(filePath, value) {
  ensureParentDirectory(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function appendClosedRows(filePath, rows) {
  if (!rows.length) {
    return;
  }

  ensureParentDirectory(filePath);
  const needsHeader = !fs.existsSync(filePath);
  const lines = [];
  if (needsHeader) {
    lines.push('Id,name,business_status,maps_link');
  }
  for (const row of rows) {
    lines.push([
      csvEscape(row.Id),
      csvEscape(row.name),
      csvEscape(row.business_status),
      csvEscape(row.maps_link),
    ].join(','));
  }
  fs.appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function createNocoDbClient(settings) {
  if (!settings.baseUrl || !settings.apiToken || !settings.baseId || !settings.tableId) {
    throw new Error('NocoDB configuration is incomplete. Set NOCODB_BASE_URL, NOCODB_API_TOKEN, NOCODB_BASE_ID, and NOCODB_TABLE_ID.');
  }

  async function request(pathname, { method = 'GET', body = null, searchParams = null } = {}) {
    const url = new URL(pathname, settings.baseUrl);
    if (searchParams) {
      for (const [key, value] of Object.entries(searchParams)) {
        if (value == null || value === '') {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'xc-auth': settings.apiToken,
        'xc-token': settings.apiToken,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    const payload = text ? safeJsonParse(text) : null;

    if (!response.ok) {
      const message = payload?.msg || payload?.message || payload?.error || `NocoDB request failed with status ${response.status}`;
      const error = new Error(message);
      error.statusCode = response.status;
      throw error;
    }

    return payload;
  }

  async function requestFallback(attempts) {
    let lastError = null;
    for (const attempt of attempts) {
      try {
        return await request(attempt.pathname, attempt);
      } catch (error) {
        lastError = error;
        if (![400, 404].includes(error.statusCode)) {
          throw error;
        }
      }
    }
    throw lastError || new Error('NocoDB request failed.');
  }

  return {
    async listTargets({ afterId, limit }) {
      return request('/api/v2/tables/' + encodeURIComponent(settings.tableId) + '/records', {
        searchParams: {
          where: `(Id,gt,${afterId})~and(source,eq,${settings.query})`,
          sort: 'Id',
          limit,
          fields: 'Id,name,address,phone,maps_link,place_id,cid,business_status,raw_json',
        },
      });
    },

    async updateRecords(records) {
      if (!records.length) {
        return null;
      }

      return requestFallback([
        {
          pathname: '/api/v2/tables/' + encodeURIComponent(settings.tableId) + '/records',
          method: 'PATCH',
          body: records,
        },
        {
          pathname: '/api/v1/db/data/noco/' + encodeURIComponent(settings.baseId) + '/' + encodeURIComponent(settings.tableId),
          method: 'PATCH',
          body: records,
        },
        {
          pathname: '/api/v1/db/data/noco/' + encodeURIComponent(settings.baseId) + '/' + encodeURIComponent(settings.tableId),
          method: 'PATCH',
          body: { list: records },
        },
      ]);
    },
  };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return { message: value };
  }
}

function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function getOriginalRawLink(row) {
  const payload = safeJsonParse(row?.raw_json || '');
  return cleanString(payload?.link);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const checkpoint = options.resume ? loadCheckpoint(options.checkpointPath) : null;

  const initialState = {
    startedAt: new Date().toISOString(),
    completedAt: null,
    lastProcessedId: Math.max(options.startId, checkpoint?.lastProcessedId || 0),
    processedCount: checkpoint?.processedCount || 0,
    updatedCount: checkpoint?.updatedCount || 0,
    permanentlyClosedCount: checkpoint?.permanentlyClosedCount || 0,
    temporarilyClosedCount: checkpoint?.temporarilyClosedCount || 0,
    openOrUnknownCount: checkpoint?.openOrUnknownCount || 0,
    failedCount: checkpoint?.failedCount || 0,
    skippedCount: checkpoint?.skippedCount || 0,
    clearedCount: checkpoint?.clearedCount || 0,
    totalRowsHint: checkpoint?.totalRowsHint || null,
  };

  const client = createNocoDbClient({
    ...config.nocoDb,
    query: options.query,
  });
  const checker = createStatusChecker({ config });

  if (!checker.isConfigured()) {
    throw new Error('Chrome/Chromium executable not found for status checker.');
  }

  let state = initialState;
  let remaining = options.limit;

  while (remaining == null || remaining > 0) {
    const batchSize = remaining == null
      ? options.batchSize
      : Math.min(options.batchSize, remaining);

    const payload = await client.listTargets({
      afterId: state.lastProcessedId,
      limit: batchSize,
    });

    const rows = Array.isArray(payload?.list) ? payload.list : [];
    const pageInfo = payload?.pageInfo || null;
    if (pageInfo && Number.isFinite(pageInfo.totalRows)) {
      state.totalRowsHint = pageInfo.totalRows;
    }

    if (rows.length === 0) {
      break;
    }

    const results = await checker.checkLeads(
      rows.map((row) => ({
        id: row.Id,
        name: row.name,
        address: row.address,
        phone: row.phone,
        link:
          options.revalidateLinklessRecoveries && !getOriginalRawLink(row)
            ? ''
            : row.maps_link,
        placeId: row.place_id,
        cid: row.cid,
      })),
      {
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
      }
    );

    const updates = [];
    const failures = [];
    const closedRows = [];

    for (const result of results) {
      state.processedCount += 1;

      if (result.status === 'failed') {
        state.failedCount += 1;
        failures.push(result);
        continue;
      }

      if (result.status === 'skipped') {
        state.skippedCount += 1;
        const original = rows.find((row) => row.Id === result.leadId) || null;
        if (
          options.revalidateLinklessRecoveries &&
          original &&
          !getOriginalRawLink(original) &&
          cleanString(original.maps_link)
        ) {
          updates.push({
            Id: result.leadId,
            business_status: '',
            maps_link: '',
          });
          state.clearedCount += 1;
        }
        continue;
      }

      if (result.status === 'permanently_closed') {
        state.permanentlyClosedCount += 1;
      } else if (result.status === 'temporarily_closed') {
        state.temporarilyClosedCount += 1;
      } else {
        state.openOrUnknownCount += 1;
      }

      updates.push({
        Id: result.leadId,
        business_status: result.status,
        maps_link: result.link || (rows.find((row) => row.Id === result.leadId)?.maps_link ?? ''),
      });

      if (result.status === 'permanently_closed' || result.status === 'temporarily_closed') {
        const original = rows.find((row) => row.Id === result.leadId) || {};
        closedRows.push({
          Id: result.leadId,
          name: original.name || '',
          business_status: result.status,
          maps_link: result.link || original.maps_link || '',
        });
      }
    }

    for (let start = 0; start < updates.length; start += options.updateBatchSize) {
      const chunk = updates.slice(start, start + options.updateBatchSize);
      await client.updateRecords(chunk);
      state.updatedCount += chunk.length;
    }

    for (const failure of failures) {
      appendJsonLine(options.failuresPath, failure);
    }
    appendClosedRows(options.closedCsvPath, closedRows);

    const lastProcessedId = rows[rows.length - 1].Id;
    state = {
      ...state,
      lastProcessedId,
    };
    saveCheckpoint(options.checkpointPath, state);

    const progressParts = [
      `lastId=${state.lastProcessedId}`,
      `processed=${state.processedCount}`,
      `updated=${state.updatedCount}`,
      `closed=${state.permanentlyClosedCount}`,
      `tempClosed=${state.temporarilyClosedCount}`,
      `openOrUnknown=${state.openOrUnknownCount}`,
      `failed=${state.failedCount}`,
      `cleared=${state.clearedCount}`,
    ];
    if (state.totalRowsHint != null) {
      progressParts.push(`target=${state.totalRowsHint}`);
    }
    console.log(progressParts.join(' '));

    if (remaining != null) {
      remaining -= rows.length;
    }
  }

  const finalState = {
    ...state,
    completedAt: new Date().toISOString(),
  };
  ensureParentDirectory(options.reportPath);
  fs.writeFileSync(options.reportPath, `${JSON.stringify(finalState, null, 2)}\n`, 'utf8');
  saveCheckpoint(options.checkpointPath, finalState);

  console.log(`Finished. report=${options.reportPath} checkpoint=${options.checkpointPath} closedCsv=${options.closedCsvPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
