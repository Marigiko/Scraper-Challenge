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

## Known Issue

**PrimeFaces 6.0 DataTable pagination** — The OEFA portal runs PrimeFaces 6.0 with a scrollable, paginated DataTable (`listarDetalleInfraccionRAAForm:dt`). Standard PrimeFaces AJAX pagination parameters (`_pagination`, `_first`, `_rows`, `behavior.event=page`) were tested exhaustively (12+ combinations) and all return page 1 data. The root cause is unknown — the table may use a non-standard configuration that ignores server-side pagination events.

**Workaround:** Excel export (341KB, all 1753 records) for metadata + per-expediente search POSTs for download UUIDs.
