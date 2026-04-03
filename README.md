# Google Maps Country Scraper

Long-running Google Maps lead scraper that accepts **country + keyword**, shards the country into resumable work units, runs `gosom/google-maps-scraper` per shard, and exposes a small authenticated dashboard for control, monitoring, cancelation, exports, and NocoDB sync.

## What it does

- resolves a country boundary with Nominatim
- starts with the country bbox and recursively splits dense shards
- runs `google-maps-scraper` against each shard using `-geo` + `-radius`
- optionally rotates proxies across shard attempts
- persists jobs, shards, sessions, and leads in SQLite
- exports CSV and JSON artifacts per job
- syncs normalized Google Maps leads into NocoDB

## Dashboard

The dashboard lets you:

- submit jobs with `country`, `keyword`, and optional proxy pool
- inspect shard status, retries, errors, and throughput
- preview lead samples as they accumulate
- cancel active jobs
- save/test NocoDB settings and push leads into a target table

## API

### Create a job

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "country": "United States",
    "keyword": "boutique hotels",
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

### Download artifacts

```bash
curl -L "http://localhost:3000/jobs/<job-id>/download?format=csv" -o leads.csv
curl -L "http://localhost:3000/jobs/<job-id>/download?format=json" -o leads.json
```

## How the country scrape works

1. Resolve the country boundary and bbox with Nominatim.
2. Seed one shard covering the whole country.
3. Run a Google Maps geo/radius search for the shard center.
4. If the shard looks saturated, split it into four children and continue.
5. Retry transient failures with backoff, optionally using a different proxy.
6. Deduplicate leads by place identifiers or stable fallback keys.
7. Finalize the job once every shard reaches a terminal state.

This is designed for multi-day runs. The service can restart and resume from SQLite state.

## Lead fields

Normalized leads include:

- `placeId`, `cid`, `dataId`, `link`
- `name`, `category`, `categories`
- `website`, `phone`, `email`
- `address`, `completeAddress`
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
- `GMAPS_FAST_MODE` default `true`
- `GMAPS_DEPTH` default `1`
- `GMAPS_CONCURRENCY` default `1`
- `GMAPS_RADIUS_CAP_METERS` default `45000`
- `GMAPS_EXIT_ON_INACTIVITY` default `90s`

### Job orchestration

- `WORKER_POLL_MS` default `5000`
- `MAX_SHARD_DEPTH` default `7`
- `RESULT_SPLIT_THRESHOLD` default `18`
- `MIN_SHARD_WIDTH_DEG` default `0.05`
- `MIN_SHARD_HEIGHT_DEG` default `0.05`
- `RETRY_LIMIT` default `6`
- `RETRY_BASE_DELAY_MS` default `60000`

### NocoDB

- `NOCODB_BASE_URL`
- `NOCODB_API_TOKEN`
- `NOCODB_BASE_ID`
- `NOCODB_TABLE_ID`
- `NOCODB_AUTO_SYNC_ON_COMPLETION`
- `NOCODB_AUTO_CREATE_COLUMNS`
- `NOCODB_PROMOTED_TAGS` top-level Google Maps fields from `raw` to promote as extra `gmaps_*` columns

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
- Proxy support is optional but useful for long-running country-scale jobs and repeated retries.
- `gosom/google-maps-scraper` behavior and blocking risk depend on your execution profile, query density, and proxy quality.
