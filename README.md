# Scraper Challenge — OEFA Repositorio Digital

Programmatic scraper for the **OEFA** (Organismo de Evaluación y Fiscalización Ambiental) public document portal. Extracts resolution metadata and downloads associated PDFs via HTTP, without any browser automation.

**Target:** `https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml`

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Orchestrator (src/index.ts)              │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │ Session    │  │ Pagination   │  │ DownloadQueue      │   │
│  │ Manager    │──│ Crawler      │──│ Agent              │   │
│  │ Agent      │  │ Agent        │  │                    │   │
│  └─────┬──────┘  └──────┬───────┘  └─────┬──────────────┘   │
│        │                 │                │                  │
│  ┌─────┴──────────┐  ┌──┴────────┐  ┌────┴──────────────┐  │
│  │ State Tracker  │  │ Document  │  │ ResilienceManager  │  │
│  │ Agent (SQLite) │  │ Parser    │  │ Agent              │  │
│  │                │  │ Agent     │  │                    │  │
│  └────────────────┘  └───────────┘  └────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

All HTTP interaction uses **axios** + **cheerio** — no Puppeteer, Playwright, or Selenium.

---

## Pipeline

The scraper collects all **1753 records** via PrimeFaces AJAX pagination, then downloads PDFs using the extracted UUIDs.

### Step 1 — PrimeFaces AJAX Pagination
An initial search POST populates the data table. Subsequent pages are fetched via PrimeFaces AJAX requests with `dt_first=<offset>` and `dt_rows=10`. The server returns XML partial-responses containing the next page's table HTML. All 176 pages (1753 records) are collected this way, with ViewState updated after every request.

### Step 2 — Metadata & UUID Extraction
Each table row is parsed for: row number, expediente, administrado, unidad fiscalizable, sector, resolución, and download UUID (extracted from the `onclick` attribute's `param_uuid`). No per-expediente searches are needed — UUIDs are available directly from the paginated table.

- Records marked *"Información confidencial"* have no download link and are skipped.
- Metadata is saved to SQLite + JSONL.

### Step 3 — Download PDF
Using the extracted UUID + command link, a POST is sent that mimics the JSF `mojarra.jsfcljs` form submission. The server streams the PDF as `application/octet-stream` (9.3MB average).

Downloads use a concurrent pool of **2–5 workers** with exponential backoff + jitter for 429/5xx retries.

---

## Modules

### `src/agents/session-manager.ts`
Stateful HTTP session via axios + `axios-cookiejar-support` + `tough-cookie`. Manages JSF ViewState extraction and cookie persistence.

| Function | Purpose |
|----------|---------|
| `createSessionClient(config)` | Builds configured Axios instance with cookie jar |
| `fetchInitialHandshake(url)` | GET → extract ViewState + cookies |
| `updateStateFromResponse(html)` | Parse new ViewState from HTML response |
| `updateStateFromAjaxResponse(xml)` | Parse new ViewState from AJAX XML response |
| `getCurrentState()` | Snapshot of current session state |
| `getSessionClient()` | Returns the Axios instance |

### `src/agents/pagination-crawler.ts`
HTTP request builders for the OEFA JSF form. Implements PrimeFaces AJAX pagination for collecting all 1753 records across 176 pages.

| Function | Purpose |
|----------|---------|
| `fetchAllPageHtml(url, vs)` | POST search with empty filters (populates data table) |
| `fetchPageViaAjax(url, vs, page)` | PrimeFaces AJAX pagination → XML partial-response |

### `src/agents/document-parser.ts`
Cheerio-based HTML parser for extracting document metadata and download UUIDs from the OEFA data table.

| Function | Purpose |
|----------|---------|
| `parsePageMetadata(html, pageIndex)` | Parse table rows from HTML → `DocumentMetadata[]` |
| `parseAjaxResponse(xml, pageIndex)` | Parse XML partial-response (extracts CDATA table + ViewState) |
| `toDocumentRecords(docs)` | Convert metadata → DB records |

### `src/agents/state-tracker.ts`
SQLite interface via `better-sqlite3`. Schema: `checkpoints`, `documents`, `dead_letter_queue`, `session_log`.

| Function | Purpose |
|----------|---------|
| `initializeDatabase(path)` | Create DB + run migrations |
| `getCheckpoint()` | Read last progress checkpoint |
| `saveCheckpoint(idx, vs)` | Save progress checkpoint |
| `upsertDocumentsBatch(docs)` | Batch upsert document records |
| `updateDocumentStatus(id, status, error?)` | Update single document |
| `logDeadLetter(record)` | Log unrecoverable failures |

### `src/agents/download-queue.ts`
Concurrent download pool. Pipes binary HTTP streams directly to disk. Supports both URL-based (GET) and JSF command-link (POST) downloads.

| Function | Purpose |
|----------|---------|
| `createQueue(config)` | Initialize download queue |
| `enqueueDownload(doc)` | Add document to download pool |
| `shutdownQueue()` | Graceful shutdown, drain pending |

### `src/agents/resilience-manager.ts`
Exponential backoff with jitter for HTTP error handling.

| Function | Purpose |
|----------|---------|
| `handleFailure(ctx)` | Determine retry course of action |
| `sleep(ms)` | Promise-based delay |

### `src/utils/`

| File | Purpose |
|------|---------|
| `constants.ts` | OEFA form IDs and Cheerio selectors |
| `download-stream.ts` | Pipe-to-disk streaming for JSF command-link POST downloads |
| `jsonl.ts` | Append-only JSONL writer for metadata export |
| `logger.ts` | Winston logger (console + file) |

### `src/migrations/001_initial.ts`
SQLite schema: `checkpoints`, `documents`, `dead_letter_queue`, `session_log`.

---

## Data Flow

```
Handshake GET ──→ Extract ViewState + JSESSIONID
     │
     ▼
Search POST (empty filters) ──→ Populate data table
     │
     ▼
Page 0: Parse metadata + UUIDs from full HTML response
     │
     ▼
Pages 1–175: AJAX pagination loop
  ├─ POST with `dt_first=<offset>`, `dt_rows=10`, etc.
  ├─ Parse XML partial-response for table HTML
  ├─ Extract metadata + UUIDs from each row
  ├─ Save to SQLite + JSONL
  ├─ Enqueue PDF download (if UUID found)
  └─ Update ViewState from AJAX response
     │
     ▼
Download Queue (2-5 workers):
  ├─ POST with command link + UUID + ViewState
  ├─ Stream octet-stream → `downloads/<year>/<id>.pdf`
  └─ Retry 5× with exponential backoff on failure
```

---

## Setup

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env if needed (defaults point to OEFA)

# TypeScript check
npm run typecheck

# Run full crawl
npm start

# Dry-run (metadata only, skip downloads)
npm start -- --dry-run
```

---

## Configuration (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `TARGET_URL` | `https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml` | Target URL |
| `DOWNLOAD_DIR` | `./downloads` | PDF download directory |
| `DATA_DIR` | `./data` | SQLite DB + JSONL output |
| `CONCURRENCY_MAX` | `3` | Max concurrent downloads |
| `MAX_RETRIES` | `5` | Max retry attempts per file |
| `BASE_DELAY_MS` | `1000` | Initial backoff (ms) |
| `MAX_DELAY_MS` | `60000` | Max backoff (ms) |
| `JITTER_FACTOR` | `0.25` | Jitter ±25% |
| `REQUEST_TIMEOUT_MS` | `30000` | HTTP timeout (ms) |
| `LOG_LEVEL` | `info` | Winston log level |

---

## Output

### `data/scraper.db` (SQLite)
- **checkpoints** — Progress tracking for resume on restart
- **documents** — All records with status (PENDING / DOWNLOADING / COMPLETED / FAILED)
- **dead_letter_queue** — Unrecoverable failures
- **session_log** — ViewState + cookie audit trail

### `data/metadata.jsonl`
Newline-delimited JSON of all document metadata. Appended as each expediente is processed.

### `data/scraper.log`
Winston log file (rotated at 5MB, 3 backups).

### `downloads/<year>/<id>.pdf`
Downloaded PDF files organized by year.

---

## Known Limitations

- **Confidential records:** ~10% of records show *"Información confidencial"* instead of a download link. These are skipped.
- **Speed:** Full crawl estimated at 45–60 minutes (metadata collection: ~2–3 min, download: ~30–50 min concurrent).
