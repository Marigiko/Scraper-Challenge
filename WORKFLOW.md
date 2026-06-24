# WORKFLOW.md — Crawl Pipeline

## Boot Sequence

```
1. dotenv.config()                  → Load .env
2. initializeDatabase(dbPath)       → Create SQLite + run migrations
3. getCheckpoint()                  → Resume from last progress, or start fresh
4. createSessionClient(config)      → Build axios instance with cookie jar
5. fetchInitialHandshake(url)       → GET target → extract ViewState + JSESSIONID
6. createQueue(config)              → Initialize download pool
7. setupSignalHandlers()            → SIGINT/SIGTERM graceful shutdown
```

## Main Loop

```
1. fetchAllPageHtml(url, state)     → POST search (empty filters) → populate data
2. exportToExcel(url, state)        → POST export button → 341KB .xls
3. Parse .xls with xlsx             → 1753 ExportRecord[] (metadata only, no UUIDs)
4. For each expediente in records:
   a. isDocumentCompleted(id)?       → Skip if already downloaded
   b. searchByExpediente(exp, url)   → POST search by expediente → 1-row HTML
   c. extractUuidFromHtml(html)      → Extract {uuid, commandLink} from onclick
   d. If no UUID found: skip (confidential record)
   e. Save DocumentMetadata to SQLite + JSONL
   f. enqueueDownload(doc)           → Add to download queue (unless --dry-run)
5. Drain download queue
```

## Download Queue

```
enqueueDownload(doc)
  → worker slot available?
    ├─ YES: processItem(doc)
    │   ├─ mkdirSync(downloads/{year}/)
    │   ├─ downloadJsfFile(client, url, formId, vs, params, destPath)
    │   │   ├─ POST with commandLink + param_uuid + ViewState
    │   │   ├─ responseType: 'stream'
    │   │   ├─ pipe to downloads/{year}/{id}.pdf
    │   │   ├─ SUCCESS → updateDocumentStatus(id, 'COMPLETED')
    │   │   └─ FAILURE → handleFailure(ctx) → retry or DLQ
    │   └─ FINALLY: release worker slot
    └─ NO: wait in FIFO queue
```

## Graceful Shutdown

```
SIGINT/SIGTERM received
  1. Set isShuttingDown = true (stops new enqueues)
  2. Wait for active workers to finish current download
  3. Close JSONL stream
  4. Close SQLite connection
  5. process.exit(0)
```
