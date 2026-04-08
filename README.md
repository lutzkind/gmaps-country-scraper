# Google Maps Country Scraper

Long-running Google Maps lead scraper that accepts **country + keyword**, shards the country into resumable work units, runs `gosom/google-maps-scraper` per shard, and exposes a small authenticated dashboard for control, monitoring, pause/resume, cancellation, exports, and NocoDB sync.

## What it does

- resolves a country boundary with Nominatim
- starts with the country bbox and proactively splits oversized shards before querying
- recursively splits dense shards for deeper coverage
- runs `google-maps-scraper` against each shard using `-geo` + `-radius`
- uses a shallow probe depth for routing shards and exhausts all pages at leaf shards
- optionally rotates proxies across shard attempts
- persists jobs, shards, sessions, and leads in SQLite
- exports CSV and JSON artifacts per job
- syncs normalized Google Maps leads into NocoDB

## Dashboard

The dashboard lets you:

- submit jobs with `country`, `keyword`, and optional proxy pool
- choose between the default fast profile and an optional comprehensive mode
- inspect shard status, retries, errors, and throughput
- preview lead samples as they accumulate
- pause, resume, or cancel active jobs
- save/test NocoDB settings and push leads into a target table

## API

### Create a job

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "country": "United States",
    "keyword": "boutique hotels",
    "comprehensiveMode": true,
    "proxies": "http://user:pass@proxy-1:8080\nhttp://user:pass@proxy-2:8080"
  }'
```

### Fetch job status

```bash
curl http://localhost:3000/jobs/<job-id>
curl http://localhost:3000/jobs/<job-id>/stats
curl http://localhost:3000/jobs/<job-id>/shards?limit=50
curl http://localhost:3000/jobs/<job-id>/errors?limit=25
curl http://localhost:3000/jobs/<job-id>/leads?limit=100
```

### Cancel a job

```bash
curl -X POST http://localhost:3000/jobs/<job-id>/cancel \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Pause or resume a job

```bash
curl -X POST http://localhost:3000/jobs/<job-id>/pause \
  -H "Content-Type: application/json" \
  -d '{}'

curl -X POST http://localhost:3000/jobs/<job-id>/resume \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Download artifacts

```bash
curl -L "http://localhost:3000/jobs/<job-id>/download?format=csv" -o leads.csv
curl -L "http://localhost:3000/jobs/<job-id>/download?format=json" -o leads.json
```

## How the country scrape works

1. Resolve the country boundary and bbox with Nominatim.
2. Seed one shard covering the whole country.
3. Pre-split large shards (radius > `GMAPS_TARGET_SHARD_RADIUS_METERS`) without querying until cells are small enough.
4. Run a Google Maps geo/radius search for the shard center.
   - **Routing shards** (can still split): use `GMAPS_DEPTH` (default `2`) — a shallow probe to detect density. Fast mode is on for speed.
   - **Leaf shards** (at `MAX_SHARD_DEPTH` or too small to divide further): use `GMAPS_LEAF_DEPTH` (default `10`) — paginates through all available results. Fast mode is off for thorough coverage.
5. If a routing shard returns ≥ `RESULT_SPLIT_THRESHOLD` results, split into four children and continue.
6. Retry transient failures with backoff, optionally using a different proxy.
7. Deduplicate leads by place identifiers or stable fallback keys.
8. Finalize the job once every shard reaches a terminal state.

### Why depth 14 and min-shard 0.002°

Google Maps caps at approximately 120 results per geo query regardless of how many pages are fetched. Full coverage therefore requires cells small enough that their restaurant count stays below that cap.

| Depth | US cell size at NYC | ~Restaurants/cell (Manhattan density) | Coverage |
|-------|--------------------|-----------------------------------------|---------|
| 10 | 29.7 × 9.4 km | ~23,700 | 0.5% |
| 12 | 7.4 × 2.3 km | ~1,480 | 8% |
| 13 | 3.7 × 1.2 km | ~370 | 32% |
| **14** | **1.9 × 0.6 km** | **~93** | **100%** |

`MIN_SHARD_WIDTH/HEIGHT_DEG` must be set below the cell dimensions at `MAX_SHARD_DEPTH` or `canSplitBBox()` returns false prematurely, silently capping real splitting before the depth limit is reached. At depth 14 the US bbox produces cells of ~0.022° × 0.005°; the 0.002° floor gives safe headroom.

Sparse/rural cells return 0 at depth 11–12 and terminate without cascading, so the extra depth only costs real queries where density warrants it.

This is designed for multi-day runs. The service can restart and resume from SQLite state.

## Lead fields

Normalized leads include:

- `placeId`, `cid`, `dataId`, `link`
- `name`, `category`, `categories`
- `website`, `phone`, `email`
- `address`, `completeAddress`
- `city`, `area`, `stateRegion`, `postcode`, `country`
- `lat`, `lon`
- `reviewCount`, `reviewRating`
- `status`, `priceRange`
- `sourceBBox`, `raw`

## Environment

### Core

- `HOST` default `0.0.0.0`
- `PORT` default `3000`
- `DATA_DIR` default `./data`
- `DB_PATH` default `./data/gmaps-country-scraper.db`
- `EXPORTS_DIR` default `./data/exports`
- `PUBLIC_BASE_URL` public dashboard URL for generated links

### Auth

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `SESSION_COOKIE_NAME` default `gmaps_scraper_session`
- `SESSION_TTL_HOURS` default `24`

### Country resolution

- `NOMINATIM_URL` default public Nominatim search endpoint
- `USER_AGENT` custom identifier for Nominatim requests

### Google Maps execution

- `GOOGLE_MAPS_BINARY` default `google-maps-scraper`
- `GMAPS_FAST_MODE` default `true` — enables the faster gosom profile for routing shards; automatically disabled for leaf shards and comprehensive mode
- `GMAPS_DEPTH` default `2` — pages fetched per routing shard query (shallow probe to detect density)
- `GMAPS_LEAF_DEPTH` default `10` — pages fetched per leaf shard query (exhaustive, used when a shard can no longer be split)
- `GMAPS_COMPREHENSIVE_DEPTH` default `10` — pages fetched in comprehensive mode (overrides both depth settings)
- `GMAPS_CONCURRENCY` default `1`
- `GMAPS_RADIUS_CAP_METERS` default `45000`
- `GMAPS_TARGET_SHARD_RADIUS_METERS` default `15000`
- `GMAPS_EXIT_ON_INACTIVITY` default `90s`

### Job orchestration

- `WORKER_POLL_MS` default `5000`
- `RUNNING_SHARD_STALE_MS` reclaim `running` shards that stay orphaned past this timeout (default `30m`)
- `MAX_SHARD_DEPTH` default `14` — maximum subdivision depth; depth-14 US cells are ~1.9 km × 0.6 km (~93 restaurants/cell at Manhattan density), keeping counts below Google's ~120-result cap for full coverage even in the densest cities
- `RESULT_SPLIT_THRESHOLD` default `18`
- `MIN_SHARD_WIDTH_DEG` default `0.002` — must be smaller than the cell width at `MAX_SHARD_DEPTH` or splitting stops prematurely
- `MIN_SHARD_HEIGHT_DEG` default `0.002`
- `RETRY_LIMIT` default `6`
- `RETRY_BASE_DELAY_MS` default `60000`

### NocoDB

- `NOCODB_BASE_URL`
- `NOCODB_API_TOKEN`
- `NOCODB_BASE_ID`
- `NOCODB_TABLE_ID`
- `NOCODB_AUTO_SYNC_ON_COMPLETION`
- `NOCODB_AUTO_SYNC_INTERVAL_MINUTES` sync new leads to NocoDB every N minutes while a job is running (default `30`, `0` disables)
- `NOCODB_AUTO_CREATE_COLUMNS`

The default synced schema already includes website, phone, email, address, city/area/state/postcode fields, reviews, and `raw_json` for full source payload retention.

## Local run

```bash
npm install
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=change-me \
USER_AGENT="gmaps-country-scraper/1.0 (+mailto:lutz.kind96@gmail.com)" \
npm start
```

Open `http://localhost:3000/login`.

## Docker

```bash
docker build -t gmaps-country-scraper .
docker run \
  -p 3000:3000 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=change-me \
  -e USER_AGENT="gmaps-country-scraper/1.0 (+mailto:lutz.kind96@gmail.com)" \
  -v "$(pwd)/data:/app/data" \
  gmaps-country-scraper
```

## Notes

- Large countries will still take a long time; this is a resumable batch system, not a one-shot scraper.
- Long jobs depend on persistent storage. In Coolify, mount a writable volume to `/app/data` so SQLite state survives redeploys.
- Orphaned `running` shards are reclaimed automatically during normal worker ticks, so a single stale claim no longer blocks job finalization until the next restart.
- Proxy support is optional but useful for long-running country-scale jobs and repeated retries.
- Comprehensive mode is job-specific and disables gosom fast mode while using the deeper depth setting.
- `gosom/google-maps-scraper` behavior and blocking risk depend on your execution profile, query density, and proxy quality.
- The extra depth levels (13 and 14) only generate real queries in genuinely dense areas; sparse cells drop out at depth 11–12 with a 0-result response, keeping total runtime proportional to actual restaurant density rather than country area.
- The container runs under `tini` as PID 1. The `gosom/google-maps-scraper` binary internally manages a Chromium instance via the `rod` library; when the binary exits under heavy load, browser renderer subprocesses can be left behind as orphans. Without a proper init process, Node.js (as PID 1) adopts these orphans but never calls `waitpid` on them, causing zombie accumulation that inflates host load average. `tini` reaps all adopted orphans immediately, keeping the process table clean across long multi-day runs.
