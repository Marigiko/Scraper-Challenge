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
  → fetchInitialHandshake(url)        — GET → extract ViewState + cookies
  → updateStateFromResponse(html)     — parse new ViewState from HTML
  → updateStateFromAjaxResponse(xml)  — parse new ViewState from AJAX XML
  → getCurrentState()                 — snapshot of current session
  → getSessionClient()                — the axios instance with cookie jar
```

All state is held in-memory. ViewState is automatically re-extracted after every POST or AJAX response.

### 2. StateTrackerAgent (`src/agents/state-tracker.ts`)
Synchronous SQLite interface via better-sqlite3. Tables: `checkpoints`, `documents`, `dead_letter_queue`, `session_log`.

```
initializeDatabase(path)  — create DB + run migrations
getCheckpoint()           — last progress snapshot
saveCheckpoint(idx, vs)   — insert progress row
upsertDocumentsBatch(docs) — transactional batch INSERT OR REPLACE
updateDocumentStatus(id, status, error?) — UPDATE by id
logDeadLetter(record)     — unrecoverable failure log
closeDatabase()           — graceful close
```

### 3. PaginationCrawlerAgent (`src/agents/pagination-crawler.ts`)
JSF form POST builders for the OEFA portal. Implements PrimeFaces AJAX pagination to collect all 1753 records across 176 pages.

```
fetchAllPageHtml(url, vs)         — search with empty filters → populate data table
fetchPageViaAjax(url, vs, page)   — AJAX pagination request → XML partial-response
```

### 4. DocumentParserAgent (`src/agents/document-parser.ts`)
Cheerio-based HTML parser for OEFA's 7-column data table. Extracts metadata and download UUIDs from `onclick` attributes.

**OEFA table columns:** Nro, Expediente, Administrado, Unidad Fiscalizable, Sector, Resolución, Download link.

```
parsePageMetadata(html, pageIndex)  — full table parser (from HTML)
parseAjaxResponse(xml, pageIndex)   — AJAX XML parser (extracts CDATA table + ViewState)
toDocumentRecords(docs)             — convert to DB records
```

### 5. DownloadQueueAgent (`src/agents/download-queue.ts`)
Concurrent download pool (2-5 workers). Streams PDFs to disk via JSF POST.

```
createQueue(config)         — initialize pool
enqueueDownload(doc)        — add to queue, start worker if slot available
shutdownQueue()             — wait for active workers, return results
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
Page 0: parse metadata + UUIDs from HTML
  ↓
Pages 1–175: AJAX pagination loop
  ├─ POST with dt_first=<offset>, dt_rows=10, dt_pagination=true
  ├─ Parse XML partial-response → extract table HTML from CDATA
  ├─ Extract metadata + UUID from each row
  ├─ Save to SQLite + JSONL
  ├─ Enqueue PDF download (if UUID found)
  └─ Update ViewState from AJAX response
  ↓
Download queue (2-5 workers):
  ├─ JSF POST (command link + UUID + ViewState)
  └─ Stream → downloads/{year}/{id}.pdf
```
