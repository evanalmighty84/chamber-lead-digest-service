# Chamber Lead Digest Railway Service

Standalone Chamber service separated from the FTN enrichment containers.

## What is included

- `chamber_classify.js` — classifies Chamber businesses into supported lead industries.
- `chamber_lead_digest.js` — finds eligible lead batches and calls the Clubhouse Links backend to send a digest.
- `lead_types.js` — canonical lead-type list required by `chamber_classify.js`.
- `run_chamber_daily.js` — one-shot runner for Railway Cron.
- `Dockerfile` — production Node 20 image.
- `.env.example` — required/optional environment-variable template.
- `.dockerignore`
- `.gitignore`
- `package.json`

## Default behavior

`npm start` runs:

1. `chamber_classify.js`
2. `chamber_lead_digest.js`

The runner is intentionally one-shot and exits after the job finishes. It is designed for a Railway **Cron** service, not an always-on web server.

If classification fails, the runner still attempts the digest so already-classified Chamber recipients can continue receiving eligible digests. The container exits non-zero afterward so the failed run remains visible.

To make the service digest-only:

```text
CHAMBER_RUN_CLASSIFY_FIRST=0
```

## Railway setup

1. Push this folder to a new Git repository.
2. Create a new Railway service from that repository.
3. Railway will detect the `Dockerfile`.
4. Add the environment variables from `.env.example`.
5. Keep `CHAMBER_DIGEST_ENABLED=0` for the first deployment.
6. Confirm the container builds and the scripts can reach PostgreSQL.
7. Configure the service as a Railway Cron job at your desired daily UTC time.
8. When ready to send real Chamber emails, set:

```text
CHAMBER_DIGEST_ENABLED=1
```

The service does not need Chrome, Xvfb, Smartproxy, FTN worker variables, or FTN failover variables.

## Important variables

### Database

Use either:

```text
DATABASE_URL
```

or:

```text
DB_USER
DB_PASSWORD
DB_HOST
DB_PORT
DB_NAME
```

### Classification

```text
PERPLEXITY_API_KEY
PPLX_API_URL
PPLX_MODEL
CHAMBER_CLASSIFY_BATCH_SIZE
CHAMBER_RUN_CLASSIFY_FIRST
```

### Digest

```text
CHAMBER_DIGEST_ENABLED
CHAMBER_DIGEST_ALLOWED_IDS
CHAMBER_DIGEST_COOLDOWN_HOURS
CHAMBER_LEAD_MAX_AGE_DAYS
CHAMBER_DIGEST_REQUEST_TIMEOUT_MS
CLUBHOUSE_API_BASE_URL
CHAMBER_ALERT_SECRET
```

Do not commit real secrets to Git.

## Local commands

Install:

```bash
npm install
```

Syntax check:

```bash
npm run check
```

Run classification only:

```bash
npm run classify
```

Run digest only:

```bash
npm run digest
```

Run the same one-shot flow Railway uses:

```bash
npm start
```

## Docker test

Build:

```bash
docker build -t chamber-lead-digest .
```

Run using a local `.env` file:

```bash
docker run --rm --env-file .env chamber-lead-digest
```

## Production separation

Recommended layout:

```text
FTN Primary  -> pre_enrichment + ftn_enrichment
FTN Backup   -> failover enrichment
Chamber Cron -> chamber classification + daily digest
```

The Chamber service should not be chained from `ftn-trigger-server.js`.

## Local Chamber directory ingestion

The same Railway service can optionally refresh `chamber_of_commerce` from
public local Chamber directories before classification runs.

Current sources:

- Allen Chamber community guide
- McKinney Chamber active member directory
- Frisco Chamber business directory
- Coppell Chamber member directory

The daily order becomes:

```text
chamber_directory_ingest.js
        ↓
chamber_classify.js
        ↓
chamber_lead_digest.js
```

The ingestion stage is intentionally disabled by default:

```text
CHAMBER_RUN_INGEST_FIRST=0
CHAMBER_INGEST_DRY_RUN=1
```

For the first test, turn on the stage but leave dry-run enabled:

```text
CHAMBER_RUN_INGEST_FIRST=1
CHAMBER_INGEST_DRY_RUN=1
CHAMBER_INGEST_SOURCES=allen,mckinney,frisco,coppell
CHAMBER_INGEST_MAX_INSERTS_PER_SOURCE=10
```

The script deduplicates against the existing table by email, normalized phone,
or company name + city. It never automatically replaces a non-empty existing
email, so manual corrections in `chamber_of_commerce` remain protected.

