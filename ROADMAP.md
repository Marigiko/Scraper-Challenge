# ROADMAP.md — Milestone Status

## Completed ✓

| Milestone | Description | Status |
|-----------|-------------|--------|
| **M1** | HTTP handshake + ViewState extraction | ✓ |
| **M2** | Session-maintained POST chain (cookies + ViewState tracking) | ✓ |
| **M3** | Excel export → parse 1753 metadata records via xlsx | ✓ |
| **M4** | Search by expediente → extract download UUID from onclick | ✓ |
| **M5** | PDF download via JSF command link POST | ✓ |
| **M6** | SQLite persistence with checkpoint resume | ✓ |
| **M7** | Concurrent download queue (2-5 workers) | ✓ |
| **M8** | Exponential backoff + jitter for 429/5xx | ✓ |
| **M9** | Dead letter queue for unrecoverable failures | ✓ |
| **M10** | JSONL metadata export for crash-independent recovery | ✓ |
| **M11** | Graceful SIGINT/SIGTERM shutdown | ✓ |
| **M12** | Confidential record detection and skip | ✓ |

## Milestone

| Milestone | Description | Status |
|-----------|-------------|--------|
| **M13** | PrimeFaces AJAX pagination (native `dt_first`/`dt_rows` params, XML partial-response parsing, ViewState tracking across pages) | ✓ |
