import Database from 'better-sqlite3';
import { runMigration } from '../migrations/001_initial.js';
import type {
  Checkpoint,
  DocumentRecord,
  DocumentStatus,
  DeadLetterRecord,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

let db: Database.Database | null = null;

export function initializeDatabase(dbPath: string): void {
  db = new Database(dbPath);
  runMigration(db);
  logger.info(`Database initialized at ${dbPath}`);
}

export function getCheckpoint(): Checkpoint | null {
  if (!db) return null;
  const row = db.prepare(
    'SELECT page_index as lastPageProcessed, view_state as viewState, updated_at as lastUpdated FROM checkpoints ORDER BY id DESC LIMIT 1',
  ).get() as { lastPageProcessed: number; viewState: string | null; lastUpdated: string } | undefined;

  if (!row) return null;

  return {
    lastPageProcessed: row.lastPageProcessed,
    viewState: row.viewState ?? null,
    lastUpdated: row.lastUpdated,
  };
}

export function saveCheckpoint(pageIndex: number, viewState: string): void {
  if (!db) return;
  db.prepare(
    'INSERT INTO checkpoints (page_index, view_state, updated_at) VALUES (?, ?, datetime(\'now\'))',
  ).run(pageIndex, viewState);
  logger.debug(`Checkpoint saved: page ${pageIndex}`);
}

export function upsertDocument(doc: DocumentRecord): void {
  if (!db) return;
  db.prepare(`
    INSERT INTO documents (id, title, expediente, file_url, file_year, file_path, status, retry_count, last_error, created_at, updated_at)
    VALUES (@id, @title, @expediente, @fileUrl, @fileYear, @filePath, @status, @retryCount, @lastError, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      expediente = excluded.expediente,
      file_url = excluded.file_url,
      file_year = excluded.file_year,
      file_path = excluded.file_path,
      status = excluded.status,
      retry_count = excluded.retry_count,
      last_error = excluded.last_error,
      updated_at = datetime('now')
  `).run(doc);
}

export function upsertDocumentsBatch(docs: DocumentRecord[]): void {
  if (!db || docs.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO documents (id, title, expediente, file_url, file_year, file_path, status, retry_count, last_error, created_at, updated_at)
    VALUES (@id, @title, @expediente, @fileUrl, @fileYear, @filePath, @status, @retryCount, @lastError, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      expediente = excluded.expediente,
      file_url = excluded.file_url,
      file_year = excluded.file_year,
      file_path = excluded.file_path,
      status = excluded.status,
      retry_count = excluded.retry_count,
      last_error = excluded.last_error,
      updated_at = datetime('now')
  `);

  const transaction = db.transaction((records: DocumentRecord[]) => {
    for (const record of records) {
      insert.run(record);
    }
  });

  transaction(docs);
}

export function updateDocumentStatus(
  docId: string,
  status: DocumentStatus,
  error?: string,
  retryCount?: number,
): void {
  if (!db) return;
  db.prepare(`
    UPDATE documents
    SET status = ?, last_error = ?, retry_count = COALESCE(?, retry_count), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, error ?? null, retryCount ?? null, docId);
}

export function getDocumentsByStatus(status: DocumentStatus): DocumentRecord[] {
  if (!db) return [];
  return db.prepare(
    'SELECT * FROM documents WHERE status = ?',
  ).all(status) as DocumentRecord[];
}

export function logDeadLetter(record: DeadLetterRecord): void {
  if (!db) return;
  db.prepare(`
    INSERT INTO dead_letter_queue (doc_id, page_index, url, error, retry_attempts, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(record.docId, record.pageIndex, record.url, record.error, record.retryAttempts);
  logger.error(`DLQ entry for doc ${record.docId}: ${record.error}`);
}

export function isDocumentCompleted(docId: string): boolean {
  if (!db) return false;
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM documents WHERE id = ? AND status = 'COMPLETED'",
  ).get(docId) as { cnt: number } | undefined;
  return row ? row.cnt > 0 : false;
}

export function closeDatabase(): void {
  if (!db) return;
  db.close();
  db = null;
  logger.info('Database connection closed');
}
