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

**Why Excel?** The OEFA portal has an "Export to Excel" button that dumps all 1753 records into a spreadsheet. This was originally used as a workaround before PrimeFaces AJAX pagination was implemented. Now used only as a diagnostic tool.

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
│   ├── pagination-crawler.ts   # JSF form POST builders
│   ├── download-queue.ts       # Concurrent download pool
│   └── resilience-manager.ts   # Retry + backoff logic
├── utils/
│   ├── constants.ts            # OEFA-specific IDs & selectors
│   ├── download-stream.ts      # File download streaming
│   ├── jsonl.ts                # JSONL file writer
│   └── logger.ts               # Winston logger setup
├── types/
│   └── index.ts                # All TypeScript interfaces
└── migrations/
    └── 001_initial.ts          # SQLite schema creation
```

---

## 3. Understanding the Target (OEFA Portal)

### What is JSF (JavaServer Faces)?

The OEFA portal is built with **JSF 2.x** using **PrimeFaces 6.0** as the UI component library. JSF is a Java web framework that:

- **Renders HTML on the server.** When you click a button, the browser sends a form POST to the server. The server processes the action, re-renders the HTML, and sends it back. There is no REST API.
- **Uses ViewState.** A hidden field (`javax.faces.ViewState`) contains an encrypted token that tracks the current UI state. Every POST must include the current ViewState or the server rejects the request.
- **Uses `mojarra.jsfcljs` for command links.** Download buttons use JavaScript to submit the form with specific parameters. The `onclick` handler calls `mojarra.jsfcljs(formElement, params, '')` which serializes the parameters and submits.

### What we discovered through exploration

Before building the crawler, the target was probed to understand its behavior:

- The server responds 200 on GET with a `javax.faces.ViewState` (~1452 chars) and a `JSESSIONID` cookie.
- Searching with empty filters returns 10 data rows in 26KB HTML.
- The paginator shows "176 pages (1753 registros)".
- The data table columns are: Nro, Expediente, Administrado, Unidad Fiscalizable, Sector, Resolución, Download button.
- Downloading a PDF works via POST with `commandLink` + `param_uuid` → 9.3MB `application/octet-stream`.
- Only 10 `<tr>` elements exist in the HTML — the table is server-side paginated.
- PrimeFaces AJAX pagination with `dt_first=<offset>` + `dt_rows=10` returns the correct page of data, confirmed by the `data-ri` attribute reflecting the row offset.

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

### Step 2: Search and Collect Page 0

**Code:** `src/index.ts:60-80`  
**Agent:** `PaginationCrawlerAgent` (`src/agents/pagination-crawler.ts`)

```typescript
const html = await fetchAllPageHtml(config.targetUrl, state.viewState);
```

**What happens:**
- A search POST with empty filters is sent. This populates the data table on the server side.
- The server returns a full HTML page containing the first 10 rows of data.
- `parsePageMetadata` extracts the metadata and UUIDs from the HTML table rows.

### Step 3: AJAX Pagination (Pages 1–175)

**Code:** `src/index.ts:86-126`

```typescript
for (let page = 1; page < 176; page++) {
  const state = getCurrentState();
  const xml = await fetchPageViaAjax(config.targetUrl, state.viewState, page);
  const { docs, newViewState } = parseAjaxResponse(xml, page);
  ...
}
```

**What happens:**
- Each page is fetched via a PrimeFaces AJAX POST with `dt_first=<offset>` and `dt_rows=10`.
- The server returns an XML partial-response containing the table HTML inside a CDATA block.
- `parseAjaxResponse` extracts the HTML from the CDATA and parses each table row.
- Rows are parsed for: nro, expediente, administrado, unidad fiscalizable, sector, resolución, and UUID (from the `onclick` attribute).
- The ViewState is updated after every request from the `<update id="j_id1:javax.faces.ViewState:0">` element in the XML response.

### Step 4: Process Each Page

**Code:** `src/index.ts:67-126`

This is the core loop. For each of the 176 pages:

#### 4a. Skip if resumed from checkpoint

```typescript
if (startPage === 0) {
  // Parse page 0 from the initial search HTML
  const page0Docs = parsePageMetadata(searchHtml, 0);
  ...
} else {
  // Resume from the checkpoint page
}
```

**Why?** On restart (after crash or interruption), the checkpoint stores the last successfully processed page. We skip pages that were already processed and resume from the next unprocessed page.

#### 4b. Fetch page via AJAX pagination

```typescript
const xml = await fetchPageViaAjax(config.targetUrl, state.viewState, page);
```

**Agent:** `PaginationCrawlerAgent` (`src/agents/pagination-crawler.ts:52-84`)

```typescript
payload.append('javax.faces.partial.ajax', 'true');
payload.append('javax.faces.source', 'listarDetalleInfraccionRAAForm:dt');
payload.append('listarDetalleInfraccionRAAForm:dt_first', String(offset));
payload.append('listarDetalleInfraccionRAAForm:dt_rows', '10');
payload.append('listarDetalleInfraccionRAAForm:dt_pagination', 'true');
```

**What happens:**
- A PrimeFaces AJAX POST is sent with the standard pagination parameters.
- `dt_first` is calculated as `page * 10` (row offset).
- The `Faces-Request: partial/ajax` header tells the server to return an XML partial-response.
- The server returns the requested page's data as HTML inside a CDATA block.

#### 4c. Extract metadata from the AJAX response

```typescript
const { docs } = parseAjaxResponse(xml, page);
```

**Agent:** `DocumentParserAgent` (`src/agents/document-parser.ts:21-48`)

The XML response has two key `<update>` elements:

```xml
<update id="listarDetalleInfraccionRAAForm:dt">
    <![CDATA[
        <tr data-ri="10"><td>11</td><td>857-2011-PRODUCE/...</td>...</tr>
    ]]>
</update>

<update id="j_id1:javax.faces.ViewState:0">
    <![CDATA[
        /wEfoQcAAAA...
    ]]>
</update>
```

**What happens:**
- Using regex, we extract the table HTML from the `listarDetalleInfraccionRAAForm:dt` CDATA block.
- The HTML is loaded into cheerio, and `<tr>` elements are parsed for the 7 columns.
- From the download column's `onclick` attribute, we extract `param_uuid` and the command link.
- The UUID is stored directly — no per-expediente search is needed.

#### 4d. Update ViewState

```typescript
updateStateFromAjaxResponse(xml);
```

**Agent:** `SessionManagerAgent` (`src/agents/session-manager.ts:93-108`)

The new ViewState from the XML response is extracted and stored. Each subsequent pagination request uses the updated ViewState, which is critical for PrimeFaces session management.

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

### Problem 1: PrimeFaces AJAX Pagination

**Symptom:** The data table shows 1753 records across 176 pages, but each page must be fetched programmatically.

**How it works:** PrimeFaces pagination uses AJAX requests with specific parameters:
- `dt_first` — row offset (0, 10, 20, ...)
- `dt_rows` — page size (10)
- `dt_pagination` — boolean flag indicating a pagination action

The server replies with an XML partial-response containing the new page's HTML inside a CDATA block, along with an updated ViewState.

**Implementation:**
1. Send an initial search POST to populate the data table (page 0).
2. For pages 1–175, send AJAX POST with `dt_first=<offset>`.
3. Parse the XML response to extract table rows and ViewState.
4. Update the session ViewState after every request.

**Key details:**
- The `Accept` header must include `application/xml` to trigger the AJAX response format.
- The `Faces-Request: partial/ajax` header tells the server this is a partial request.
- The ViewState is returned in a separate `<update>` element, not in the HTML form.

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
