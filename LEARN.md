# LEARN.md — How This Scraper Was Built

This document is a guided walkthrough of the entire project: what each library does, why it was chosen over alternatives, how the code is structured, and the reasoning behind every major decision.

---

## Table of Contents

1. [Library Choices & Why](#1-library-choices--why)
2. [Project Foundation & Tooling](#2-project-foundation--tooling)
3. [Understanding the Target (OEFA Portal)](#3-understanding-the-target-oefa-portal)
4. [Agent Architecture — Why Modular?](#4-agent-architecture--why-modular)
5. [Step-by-Step Implementation](#5-step-by-step-implementation)
6. [Solving Real Problems](#6-solving-real-problems)

---

## 1. Library Choices & Why

### `axios` — HTTP Client

**What it does:** Sends HTTP requests (GET, POST, etc.) and handles responses.

**Why not `fetch`?** Node.js has a built-in `fetch` API since v18, but `axios` provides:
- **Interceptors** — Code that runs automatically before every request or after every response. We use this to attach cookies and parse ViewState.
- **`responseType: 'stream'`** — Download files by piping data directly to disk, which avoids loading a 9MB PDF into memory all at once.
- **`validateStatus`** — Custom logic to decide which HTTP status codes count as "success" (we accept `< 400` for downloads because some valid responses might be 302 redirects or 3xx).
- **Broader compatibility** — Works identically across Node.js versions, unlike `fetch` which had stability issues before v21.

### `axios-cookiejar-support` + `tough-cookie` — Cookie Management

**What it does:** Makes `axios` automatically store and send cookies, just like a web browser.

**Why tough-cookie v5 specifically?** The JSF server issues a `JSESSIONID` cookie during the initial handshake. Every subsequent request MUST include this cookie or the server treats it as a new session. `axios-cookiejar-support` patches `axios` to use a `tough-cookie` `CookieJar` automatically, so we never have to manually extract or attach `Cookie` headers.

**Why not v6?** `axios-cookiejar-support` v7 (latest) depends on tough-cookie v5. There is a compatibility break with v6.

### `cheerio` — HTML Parser

**What it does:** Loads HTML strings and lets you query elements with CSS selectors (like jQuery).

**Why not `jsdom`?** `jsdom` creates a full DOM environment, including running JavaScript, layout calculation, etc. That's overkill and slow. `cheerio` is a lightweight parser that only handles static HTML — perfect for extracting data from server-rendered pages. The OEFA portal renders its data table entirely on the server; no client-side JavaScript is needed to populate the rows.

**Why not regex?** Regex is fragile. A single HTML attribute order change breaks the pattern. `cheerio` with CSS selectors is robust against minor HTML variations.

### `better-sqlite3` — SQLite Database

**What it does:** Synchronous SQLite database access.

**Why synchronous?** SQLite is an embedded database (single file, no server). Synchronous operations are simpler, faster (no async overhead), and avoid race conditions. For a scraper that processes records one at a time, synchronous DB writes are perfect.

**Why not `sql.js`?** `sql.js` compiles SQLite to WebAssembly, which works but has a different API and slower performance. `better-sqlite3` is the native Node.js standard.

**Why is crash resilience important?** A crawl of 1753 records takes 45-60 minutes. If the process crashes at record 1500, you don't want to restart from 0. SQLite stores a checkpoint after every record, and `isDocumentCompleted()` skips already-finished records on resume.

### `winston` — Logging

**What it does:** Structured logging to console and file.

**Why not `console.log`?** For a long-running scraper, you need:
- **Timestamps** on every log line
- **Log levels** (info, warn, error, debug) to control verbosity
- **File output** so you can review what happened after a crash
- **Log rotation** so the log file doesn't grow forever

### `xlsx` — Excel File Parser

**What it does:** Reads `.xls` and `.xlsx` files.

**Why Excel?** The OEFA portal has an "Export to Excel" button that dumps all 1753 records into a spreadsheet. This is the only way to get ALL metadata at once, since pagination doesn't work (more on that below). We parse the Excel file to get expediente numbers, then use those to search for download UUIDs one by one.

### `dotenv` — Environment Variables

**What it does:** Loads `.env` file into `process.env`.

**Why?** Configuration values (target URL, timeouts, concurrency) should not be hardcoded. They change between environments or over time. `.env` keeps them in one place without needing command-line flags.

### `form-data` — Multipart Form Data

**What it does:** Builds `multipart/form-data` payloads.

**Why is it installed if not used?** It was used during experimentation with pagination (multipart encoding is one of the 12+ parameter combinations we tested). It remains in `package.json` as a dependency for potential future use.

### `tsx` — TypeScript Runner

**What it does:** Runs `.ts` files directly without a separate compilation step.

**Why not `ts-node`?** `ts-node` with ESM (`type: "module"` in package.json) has persistent bugs with `--loader` flags and inspector protocol errors. `tsx` (built on esbuild) handles ESM TypeScript cleanly and is significantly faster.

---

## 2. Project Foundation & Tooling

### `package.json` — `"type": "module"`

**What it does:** Tells Node.js to treat all `.js` files as ES modules (using `import`/`export`) instead of CommonJS (`require`/`module.exports`).

**Why?** Modern JavaScript/TypeScript uses ES modules. All our dependencies ship ESM-compatible code. This avoids the `require is not defined` errors that occur when mixing module systems.

### `tsconfig.json` — Compiler Configuration

Key settings and why:

```json
{
  "target": "ES2022",           // Use modern JavaScript features (async/await, optional chaining, etc.)
  "module": "NodeNext",          // Node.js native ESM resolution (requires .js extensions in imports)
  "moduleResolution": "NodeNext",// Follow Node.js module resolution rules
  "strict": true,                // Enable all type-checking options — catches bugs at compile time
  "noUnusedLocals": true,        // Error on unused variables — keeps code clean
  "noUnusedParameters": true     // Error on unused function parameters
}
```

**Why `moduleResolution: "NodeNext"` forces `.js` extensions in imports?**  
In ESM, import paths must include the file extension. TypeScript with `NodeNext` enforces this, so `import { foo } from './bar.js'` is required (even though the source file is `bar.ts`). This seems annoying but ensures the compiled JavaScript works correctly at runtime.

### Project Structure

```
src/
├── index.ts                    # Orchestrator — starts everything
├── agents/
│   ├── session-manager.ts      # HTTP session + cookies + ViewState
│   ├── state-tracker.ts        # SQLite read/write
│   ├── document-parser.ts      # Cheerio HTML parsing
│   ├── pagination-crawler.ts   # JSF form POSTs (search, export)
│   ├── download-queue.ts       # Concurrent download pool
│   └── resilience-manager.ts   # Retry + backoff logic
├── utils/
│   ├── constants.ts            # OEFA-specific IDs & selectors
│   ├── download-stream.ts      # File download streaming
│   ├── jsf-payload.ts          # POST body builders
│   ├── jsonl.ts                # JSONL file writer
│   └── logger.ts               # Winston logger setup
├── types/
│   └── index.ts                # All TypeScript interfaces
├── migrations/
│   └── 001_initial.ts          # SQLite schema creation
└── sniff-*.ts                  # Interactive exploration scripts
```

---

## 3. Understanding the Target (OEFA Portal)

### What is JSF (JavaServer Faces)?

The OEFA portal is built with **JSF 2.x** using **PrimeFaces 6.0** as the UI component library. JSF is a Java web framework that:

- **Renders HTML on the server.** When you click a button, the browser sends a form POST to the server. The server processes the action, re-renders the HTML, and sends it back. There is no REST API.
- **Uses ViewState.** A hidden field (`javax.faces.ViewState`) contains an encrypted token that tracks the current UI state. Every POST must include the current ViewState or the server rejects the request.
- **Uses `mojarra.jsfcljs` for command links.** Download buttons use JavaScript to submit the form with specific parameters. The `onclick` handler calls `mojarra.jsfcljs(formElement, params, '')` which serializes the parameters and submits.

### What we discovered by sniffing

The sniff scripts (`src/sniff-*.ts`) were written to probe the target and understand its behavior before building the main crawler. Here's what each taught us:

**`sniff-handshake.ts`:**
- Confirmed the server responds 200 on GET with a `javax.faces.ViewState` (~1452 chars) and a `JSESSIONID` cookie.
- Searched with empty filters → 10 data rows, 26KB HTML.
- Downloaded a PDF successfully via POST with `commandLink` + `param_uuid` → 9.3MB `application/octet-stream`.
- **Key insight:** The download works by simulating `mojarra.jsfcljs` with a POST body containing the command link and UUID.

**`sniff-analyze.ts`:**
- Parsed the paginator HTML and found it shows "176 pages (1753 registros)".
- Identified the data table columns: Nro, Expediente, Administrado, Unidad Fiscalizable, Sector, Resolución, Download button.
- Found the Excel export button: `listarDetalleInfraccionRAAForm:dt:j_idt38`.

**`sniff-export.ts`:**
- Confirmed the Excel export POST returns a 341KB `.xls` file (not HTML).
- Parsed the 1753 records via `xlsx` library.

**`sniff-pagination.ts` (multiple versions):**
- Tested 12+ parameter combinations: `_pagination`, `_first`, `_rows`, `behavior.event=page`, `partial.event=page`, various `javax.faces.source` values, `FormData`, `URLSearchParams`, `scrollState`, `multipart`, etc.
- **All returned page 1.** This was the critical discovery that forced the architecture change.

**`sniff-check-rows.ts`:**
- Confirmed only 10 `<tr>` elements exist in the HTML, not 1753. The DataTable is NOT client-side pagination with all data hidden — it truly only sends 10 rows.

**`sniff-read-excel.ts`:**
- Parsed the Excel export and identified its 6 columns: Nro, Expediente, Administrado, Unidad Fiscalizable, Sector, Resolución.
- Saved as JSONL for later use.

**`sniff-compare.ts`:**
- Compared page 1 vs "page 2" responses — identical content and ViewState, confirming pagination truly doesn't work.

---

## 4. Agent Architecture — Why Modular?

### The Problem

A web scraper has multiple distinct responsibilities:
1. **Session management** — cookies, ViewState tracking
2. **Data extraction** — parse HTML into structured data
3. **Storage** — save to database and files
4. **Download management** — concurrent downloads with retries
5. **Error handling** — backoff, retry, dead letter queue

Putting all of this in one file creates spaghetti code. Every change requires understanding the entire file.

### The Solution

Separate each concern into its own "agent" (module) with a clear interface:

- **`SessionManagerAgent`** — Knows about HTTP, cookies, and ViewState. Nothing else.
- **`DocumentParserAgent`** — Knows about HTML structure and cheerio selectors. Nothing else.
- **`PaginationCrawlerAgent`** — Knows about JSF form parameters and how to construct POST bodies. Nothing else.
- **`DownloadQueueAgent`** — Manages concurrency. Doesn't care where files come from or how they're saved.
- **`ResilienceManagerAgent`** — Pure math (backoff calculation). No side effects.
- **`StateTrackerAgent`** — Pure SQL. No HTTP, no parsing.

**Result:** You can change the HTML parser without touching the download code. You can switch from SQLite to PostgreSQL without touching the HTTP code. You can test the backoff math without making real HTTP requests.

### The Orchestrator

`src/index.ts` is the "composition root" — it imports all agents, wires them together, and runs the main loop. It's the only file that knows about all agents, and it's the only file that needs to change if you want a different workflow.

---

## 5. Step-by-Step Implementation

### Step 1: Initialize and Handshake

**Code:** `src/index.ts:57-70`  
**Agent:** `SessionManagerAgent` (`src/agents/session-manager.ts`)

```typescript
initializeDatabase(dbPath);
createSessionClient(sessionConfig);
const handshake = await fetchInitialHandshake(config.targetUrl);
```

**What happens:**
1. SQLite database is created (or opened if it exists). Tables are created via migration.
2. An axios instance is created with a `CookieJar` attached. From now on, every request automatically stores and sends cookies.
3. A GET request is sent to the target URL. The server responds with:
   - A `Set-Cookie: JSESSIONID=...` header (new session)
   - HTML containing `<input type="hidden" name="javax.faces.ViewState" value="...">`

**Why is the handshake necessary?** JSF requires ViewState in every POST. Without it, the server throws an error or ignores the request. The initial GET is the only way to get the first ViewState.

### Step 2: Search and Export All Records

**Code:** `src/index.ts:85-96`  
**Agent:** `PaginationCrawlerAgent` (`src/agents/pagination-crawler.ts`)

```typescript
const html = await fetchAllPageHtml(config.targetUrl, state.viewState);
const excelBuffer = await exportToExcel(config.targetUrl, state.viewState);
```

**What happens:**
1. A search POST with empty filters is sent. This populates the data table on the server side. Without this step, the Excel export returns HTML instead of a spreadsheet.
2. An export POST is sent to the button `listarDetalleInfraccionRAAForm:dt:j_idt38`. The server generates a `.xls` file and returns it as a binary buffer.

**Why search first?** The Excel export button only exports whatever data is currently in the table. If no search has been performed, the table is empty, and the export button returns an HTML page with an error message.

### Step 3: Parse Excel Data

**Code:** `src/index.ts:17-38`

```typescript
function parseExportData(buffer: Buffer): ExportRecord[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  // Skip header row (index 0), parse remaining rows
  for (let i = 1; i < data.length; i++) { ... }
}
```

**What happens:**
- `xlsx` reads the buffer and parses it into a workbook.
- `sheet_to_json` with `header: 1` returns an array of arrays (row-based), where each array is a row of cell values.
- Row 0 is headers (Nro, Expediente, Administrado, etc.). Rows 1+ are data.
- We extract the 6 columns into `ExportRecord` objects.

**Why skip the header row?** The first row contains column labels, not data. Without skipping, every record would have labels mixed in.

### Step 4: Process Each Expediente

**Code:** `src/index.ts:101-159`

This is the core loop. For each of the 1753 expedientes:

#### 4a. Check if already completed

```typescript
if (isDocumentCompleted(normalizeId(`${exp.expediente}_${exp.nro}`))) {
  recordsProcessed++;
  continue;
}
```

**Why?** On restart (after crash or interruption), we don't want to re-process records that already have their PDFs downloaded. `isDocumentCompleted` checks the SQLite `documents` table for a `COMPLETED` status. If found, skip.

#### 4b. Search by expediente

```typescript
const html = await searchByExpediente(exp.expediente, config.targetUrl, state.viewState);
```

**Agent:** `PaginationCrawlerAgent` (`src/agents/pagination-crawler.ts:14-37`)

```typescript
const payload = new URLSearchParams();
payload.append(FORM_ID, FORM_ID);
payload.append(EXPEDIENTE_FIELD, expediente);  // e.g., "857-2011-PRODUCE/DIGSECOVI-Dsvs"
payload.append(SEARCH_BUTTON, 'Buscar');
payload.append('javax.faces.ViewState', viewState);
payload.append('javax.faces.source', SEARCH_BUTTON);
```

**What happens:**
- A POST is sent with the expediente number in the `txtNroexp` field.
- The server looks up records matching that exact expediente and returns them in the data table.
- For unique expedientes (which most are), exactly 1 row is returned.
- The `updateStateFromResponse` function in `SessionManagerAgent` parses the new ViewState from the response HTML and stores it for the next request.

**Why search one-by-one instead of paginating?** Because pagination doesn't work (confirmed by testing 12+ parameter combinations). This brute-force approach is reliable: it works with 100% certainty for every record.

#### 4c. Extract UUID

```typescript
const uuidData = extractUuidFromHtml(html);
if (!uuidData) {
  logger.warn(`No download link for expediente: ${exp.expediente} (confidential or unavailable)`);
  recordsProcessed++;
  continue;
}
```

**Agent:** `DocumentParserAgent` (`src/agents/document-parser.ts:96-108`)

```typescript
const $ = cheerio.load(html);
const downloadLink = $('a[onclick]').first();
const onclick = downloadLink.attr('onclick') || '';
const uuidMatch = onclick.match(/param_uuid[^:]*:'([^']+)'/);
const cmdMatch = onclick.match(/'([^']+?:j_idt63)'/);
if (uuidMatch && cmdMatch) {
  return { uuid: uuidMatch[1], commandLink: cmdMatch[1] };
}
```

**What happens:**
- The HTML is loaded into cheerio.
- We look for `<a onclick="mojarra.jsfcljs(...)">` elements.
- Using regex, we extract two values from the `onclick` attribute:
  - `param_uuid`: The UUID that identifies the specific document
  - `commandLink`: The component ID (like `listarDetalleInfraccionRAAForm:dt:0:j_idt63`)

**Why regex on onclick instead of cheerio?** The UUID is embedded inside a JavaScript string within an HTML attribute. Cheerio can find the attribute value, but extracting the UUID from within that JavaScript string requires pattern matching (regex). This is one of the few places where regex is the right tool.

**Why might no UUID be found?** Some records show "Información confidencial" instead of a download link. These records simply don't have downloadable PDFs — they're marked as confidential by OEFA. We skip them.

#### 4d. Save metadata

```typescript
const doc: DocumentMetadata = {
  id: normalizeId(`${exp.expediente}_${exp.nro}`),
  expediente: exp.expediente,
  title: exp.administrado,
  date: exp.resolucion,
  fileUrl: JSON.stringify(uuidData),
  fileYear: year,
  sourcePage: 1,
  downloadParams: uuidData,
};

const records = toDocumentRecords([doc]);
upsertDocumentsBatch(records);
appendJsonl([doc]);
```

**What happens:**
- A `DocumentMetadata` object is created with the metadata from the Excel export + the UUID from the search.
- `fileUrl` stores the download params as JSON (since the download is a POST, not a URL).
- The record is upserted into SQLite (INSERT if new, UPDATE if existing).
- The record is appended to `metadata.jsonl` for easy inspection without SQLite.

### Step 5: Enqueue Download

```typescript
if (!config.dryRun) {
  downloadQueue.enqueueDownload(doc);
}
```

**Agent:** `DownloadQueueAgent` (`src/agents/download-queue.ts`)

**What happens:**
1. The document is pushed to a queue.
2. If the number of active workers is below `maxConcurrency`, a worker starts immediately. Otherwise, the document waits.
3. The worker:
   a. Creates the year-based directory (e.g., `downloads/2012/`).
   b. Calls `getCurrentState()` to get the latest ViewState.
   c. Calls `downloadJsfFile()` which builds a POST body with the command link, UUID, and ViewState.
   d. Sends the POST with `responseType: 'stream'`.
   e. Pipes the stream directly to `writeFileSync` at the destination path.
   f. On success: updates DB status to `COMPLETED`.
   g. On failure: calls `ResilienceManagerAgent` to determine backoff and retry.

**Why stream the download?** A 9MB PDF loaded into memory would be fine once, but with 1500+ PDFs, memory usage would grow. Streaming writes each chunk to disk as it arrives, keeping memory constant regardless of file size.

**Why pass ViewState from `getCurrentState()`?** The ViewState changes with every POST. The search in Step 4b already updated the ViewState. We need the latest one for the download POST. This is the same ViewState that was just extracted from the search response.

### Step 6: Save Checkpoint

```typescript
recordsProcessed++;
saveCheckpoint(recordsProcessed, getCurrentState().viewState);
```

**Agent:** `StateTrackerAgent` (`src/agents/state-tracker.ts:34-40`)

```typescript
db.prepare(
  'INSERT INTO checkpoints (page_index, view_state, updated_at) VALUES (?, ?, datetime(\'now\'))',
).run(pageIndex, viewState);
```

**What happens:** A new row is inserted into the `checkpoints` table. The `page_index` stores the count of processed records, and `view_state` stores the latest ViewState.

**Why insert instead of update?** Appending checkpoint rows creates an audit trail. On restart, `getCheckpoint()` reads the latest row (`ORDER BY id DESC LIMIT 1`). If you ever need to debug what happened, all checkpoints are available.

### Step 7: Shutdown

```typescript
async function performShutdown(downloadQueue) {
  await downloadQueue.shutdownQueue();
  closeJsonlStream();
  closeDatabase();
}
```

**What happens on SIGINT/SIGTERM:**
1. The shutdown flag is set, preventing new downloads from starting.
2. `shutdownQueue()` waits for active workers to finish their current file.
3. Pending items remain in the queue (will be processed on next run).
4. The JSONL stream is closed.
5. The SQLite connection is closed.
6. The process exits.

**Why not save a checkpoint on shutdown?** The checkpoint was already saved after processing each record (Step 6). If the process is killed mid-download, the record is still in `PENDING` state and will be retried on restart.

---

## 6. Solving Real Problems

### Problem 1: Pagination Doesn't Work

**Symptom:** Every pagination request (12+ parameter combinations) returns page 1.

**Hypothesis:** The PrimeFaces 6.0 DataTable is configured as non-lazy (`lazy="false"`), which means all data should be rendered client-side. But only 10 rows are in the HTML. This seems contradictory — it suggests the table IS using some form of server-side filtering, but pagination parameters are ignored.

**Resolution:** Instead of fighting pagination, we pivot to a different strategy:
1. Use the Excel export to get all metadata (1753 records).
2. Search by individual expediente numbers to get UUIDs one at a time.
3. Download each PDF using the extracted UUID.

**Lesson:** When a feature doesn't work despite exhaustive testing, don't keep trying the same approach. Find a different way to achieve the same goal.

### Problem 2: ViewState Staleness

**Symptom:** After many requests, the server returns errors or unexpected HTML.

**Root cause:** The `javax.faces.ViewState` changes after every POST. Using a stale ViewState causes the server to reject the request.

**Resolution:** After every POST response, `updateStateFromResponse()` parses the new ViewState and stores it. The orchestrator calls `getCurrentState()` before every request to ensure it always uses the latest ViewState.

```typescript
// In the loop:
const state = getCurrentState();              // Get latest ViewState
const html = await searchByExpediente(..., state.viewState);
updateStateFromResponse(html);                 // ViewState is automatically updated
// Next iteration: getCurrentState() returns the updated ViewState
```

### Problem 3: Download Queue Bottlenecks

**Symptom:** One slow download blocks all others.

**Resolution:** Use a concurrent queue with a configurable worker pool. While one worker is waiting for a 5-second download, another worker can start a different download.

```typescript
// In download-queue.ts
private async drain(): Promise<void> {
  while (this.activeWorkers < this.maxConcurrency && this.queue.length > 0) {
    const item = this.queue.shift()!;
    this.activeWorkers++;
    this.processItem(item).finally(() => this.activeWorkers--);
  }
}
```

Each worker runs independently. The `while` loop starts new workers as long as there are slots available.

### Problem 4: Rate Limiting and Retries

**Symptom:** The server returns HTTP 429 (Too Many Requests) after too many concurrent requests.

**Resolution:** `ResilienceManagerAgent` implements exponential backoff:

```
delay = min(maxDelay, baseDelay * 2^attempt) + randomJitter
```

- `baseDelay = 1000ms` (1 second)
- After 1st failure: `min(60000, 1000 * 2^1) = 2000ms` (± 25% jitter = 1500-2500ms)
- After 2nd failure: `min(60000, 1000 * 2^2) = 4000ms` (± 25% jitter = 3000-5000ms)
- After 5th failure: `min(60000, 1000 * 2^5) = 60000ms` (capped at 60 seconds)

When a 429 is received, the entire queue pauses (`this.isPaused = true`) for the backoff duration. This prevents all workers from retrying simultaneously and overwhelming the server.

### Problem 5: Crash Recovery

**Symptom:** The script crashes at record 1500 of 1753. Starting over from record 0 would waste hours.

**Resolution:** Three mechanisms work together:

1. **SQLite checkpoints:** After every processed record, a checkpoint is saved. On restart, we read the latest checkpoint and skip to the next unprocessed record.

2. **Document status tracking:** Each document has a status: `PENDING` → `DOWNLOADING` → `COMPLETED` or `FAILED`. On restart, `isDocumentCompleted()` skips already-downloaded files.

3. **Upsert semantics:** `upsertDocumentsBatch` uses `INSERT ... ON CONFLICT(id) DO UPDATE`. If a record was partially saved before the crash, re-running it just updates the existing row instead of creating a duplicate.

### Problem 6: JavaScript Function Simulation

**Symptom:** The download button uses `mojarra.jsfcljs()` — a JavaScript function that's not available in our Node.js environment.

**Resolution:** We reverse-engineer what `mojarra.jsfcljs` does:
1. It takes the form element, a map of parameters, and a target string.
2. It creates hidden input elements for each parameter.
3. It submits the form via `form.submit()`.

Instead of running the JavaScript (which would require a browser), we replicate the final result: a POST body with the parameters serialized as form data.

```typescript
// What the JavaScript does (conceptually):
// mojarra.jsfcljs(formElement, {
//   'listarDetalleInfraccionRAAForm:dt:0:j_idt63': '...',
//   'param_uuid': '153a6d2a-...'
// }, '');

// What we do instead:
const payload = new URLSearchParams();
payload.append('listarDetalleInfraccionRAAForm', 'listarDetalleInfraccionRAAForm');
payload.append('listarDetalleInfraccionRAAForm:dt:0:j_idt63', 'listarDetalleInfraccionRAAForm:dt:0:j_idt63');
payload.append('param_uuid', '153a6d2a-...');
payload.append('javax.faces.ViewState', viewState);
await client.post(url, payload.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
```

This is a general principle: when reverse-engineering a web application, figure out what the JavaScript DOES, not what it SAYS. It's easier to replicate the outcome than to execute the original code.

---

## Quick Reference

| Library | Purpose | Why This One |
|---------|---------|-------------|
| axios | HTTP client | Interceptors, streaming, status validation |
| axios-cookiejar-support | Auto cookie handling | Transparent JSESSIONID management |
| tough-cookie | Cookie storage | Compatible with axios-cookiejar-support |
| cheerio | HTML parsing | Lightweight, jQuery-like selectors |
| better-sqlite3 | SQLite database | Sync ops, crash resilience, simple API |
| winston | Logging | Timestamps, levels, file rotation |
| xlsx | Excel parsing | Read .xls export from OEFA portal |
| dotenv | Environment config | Isolate configuration from code |
| tsx | TypeScript runner | Fast ESM-compatible execution |
