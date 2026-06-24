import Database from 'better-sqlite3';

export function runMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      page_index    INTEGER NOT NULL,
      view_state    TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id            TEXT PRIMARY KEY,
      title         TEXT,
      expediente    TEXT,
      file_url      TEXT,
      file_year     INTEGER,
      file_path     TEXT,
      status        TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DOWNLOADING','COMPLETED','FAILED')),
      retry_count   INTEGER DEFAULT 0,
      last_error    TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dead_letter_queue (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id         TEXT,
      page_index     INTEGER,
      url            TEXT,
      error          TEXT,
      retry_attempts INTEGER,
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS session_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      view_state    TEXT NOT NULL,
      cookies       TEXT,
      source_url    TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
  `);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}
