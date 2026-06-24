# AGENTS.md — Agent Architecture

## Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    Orchestrator (src/index.ts)                │
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

## Agents

### 1. SessionManagerAgent (`src/agents/session-manager.ts`)
Stateful HTTP session via axios + tough-cookie. Manages cookies and JSF ViewState tokens.

```
createSessionClient(config)
  → fetchInitialHandshake(url)   — GET → extract ViewState + cookies
  → updateStateFromResponse(html) — parse new ViewState from any response
  → getCurrentState()            — snapshot of current session
  → getSessionClient()           — the axios instance with cookie jar
```

All state is held in-memory. ViewState is automatically re-extracted after every POST.

### 2. StateTrackerAgent (`src/agents/state-tracker.ts`)
Synchronous SQLite interface via better-sqlite3. Tables: `checkpoints`, `documents`, `dead_letter_queue`, `session_log`.

```
initializeDatabase(path)  — create DB + run migrations
getCheckpoint()           — last progress snapshot
saveCheckpoint(idx, vs)   — insert progress row
upsertDocumentsBatch(docs) — transactional batch INSERT OR REPLACE
updateDocumentStatus(id, status, error?) — UPDATE by id
isDocumentCompleted(id)   — dedup check
logDeadLetter(record)     — unrecoverable failure log
closeDatabase()           — graceful close
```

### 3. PaginationCrawlerAgent (`src/agents/pagination-crawler.ts`)
JSF form POST builders for the OEFA portal. Pagination is not supported (PrimeFaces 6.0 DataTable ignores pagination params), so this module provides alternative endpoints.

```
searchByExpediente(exp, url, vs)  — search by exact expediente number → 1-row HTML
fetchAllPageHtml(url, vs)         — search with empty filters → all records page 1
exportToExcel(url, vs)            — trigger Excel export → 341KB .xls buffer
```

### 4. DocumentParserAgent (`src/agents/document-parser.ts`)
Cheerio-based HTML parser for OEFA's 7-column data table. Extracts metadata and download UUIDs from `onclick` attributes.

**OEFA table columns:** Nro, Expediente, Administrado, Unidad Fiscalizable, Sector, Resolución, Download link.

```
parsePageMetadata(html, pageIndex)  — full table parser
extractUuidFromHtml(html)           — extract {uuid, commandLink} from onclick
toDocumentRecords(docs)             — convert to DB records
normalizeId(rawId)                  — slugify document ID
extractYear(str)                    — extract 4-digit year
```

### 5. DownloadQueueAgent (`src/agents/download-queue.ts`)
Concurrent download pool (2-5 workers). Streams PDFs to disk via JSF POST.

```
createQueue(config)         — initialize pool
enqueueDownload(doc)        — add to queue, start worker if slot available
shutdownQueue()             — wait for active workers, return results
getQueueStats()             — active/pending/completed/failed counts
```

**Download flow:** JSF POST with command link + UUID + ViewState → `responseType: 'stream'` → pipe to `downloads/{year}/{id}.pdf`.

### 6. ResilienceManagerAgent (`src/agents/resilience-manager.ts`)
Pure retry/backoff math. No side effects.

```
calculateBackoff(attempt, policy?)  — min(maxDelay, baseDelay × 2^attempt) + jitter
shouldRetry(attempt, policy?)       — attempt < maxRetries?
handleFailure(ctx)                  — decide retry vs abandon
isRetryableError(statusCode)        — 429/502/503/504/5xx
sleep(ms)                           — Promise-based delay
```

---

## Pipeline

```
HANDSHAKE (GET)
  ↓
SEARCH ALL (empty POST) → populate data table
  ↓
EXPORT EXCEL (POST) → 341KB .xls → 1753 metadata records
  ↓
For each expediente (1…1753):
  ├─ SEARCH BY EXPEDIENTE (POST) → 1-row HTML
  ├─ Extract UUID from onclick
  ├─ Save to SQLite + JSONL
  └─ Enqueue PDF download (if UUID found)
  ↓
Download queue (2-5 workers):
  ├─ JSF POST (command link + UUID + ViewState)
  └─ Stream → downloads/{year}/{id}.pdf
```
