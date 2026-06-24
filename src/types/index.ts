export interface SessionState {
  viewState: string;
  cookies: string;
  lastUpdated: number;
  clientWindow?: string;
}

export interface HandshakeResult {
  state: SessionState;
  rawHtml: string;
  status: number;
}

export interface SessionConfig {
  targetUrl: string;
  fallbackUrl: string;
  timeout: number;
  userAgent: string;
}

export interface Checkpoint {
  lastPageProcessed: number;
  viewState: string | null;
  lastUpdated: string;
}

export type DocumentStatus = 'PENDING' | 'DOWNLOADING' | 'COMPLETED' | 'FAILED';

export interface DocumentRecord {
  id: string;
  title: string;
  expediente: string;
  fileUrl: string;
  fileYear: number;
  filePath: string | null;
  status: DocumentStatus;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeadLetterRecord {
  docId: string;
  pageIndex: number;
  url: string;
  error: string;
  retryAttempts: number;
  createdAt: string;
}

export interface DownloadParams {
  commandLink: string;
  uuid: string;
}

export interface DocumentMetadata {
  id: string;
  expediente: string;
  title: string;
  date: string;
  fileUrl: string;
  fileYear: number;
  sourcePage: number;
  downloadParams?: DownloadParams;
}

export interface ParseResult {
  docs: DocumentMetadata[];
  totalRecordsOnPage: number;
  hasMoreData: boolean;
}

export interface DownloadTask {
  doc: DocumentMetadata;
  destinationPath: string;
  attempt: number;
  createdAt: number;
}

export interface DownloadResult {
  success: boolean;
  docId: string;
  filePath: string | null;
  error: string | null;
  attempts: number;
  durationMs: number;
}

export interface QueueConfig {
  minConcurrency: number;
  maxConcurrency: number;
  downloadDir: string;
}

export interface QueueStats {
  activeWorkers: number;
  pendingItems: number;
  completedCount: number;
  failedCount: number;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
}

export interface BackoffResult {
  delayMs: number;
  attempt: number;
  isFinalAttempt: boolean;
}

export interface FailureContext {
  docId: string;
  pageIndex: number;
  url: string;
  attempt: number;
  statusCode: number | null;
  errorMessage: string;
  retryAfter: number | null;
}

export interface OrchestratorConfig {
  targetUrl: string;
  downloadDir: string;
  dataDir: string;
  concurrency: number;
  retryPolicy: RetryPolicy;
  dryRun?: boolean;
}

export interface ExportRecord {
  nro: string;
  expediente: string;
  administrado: string;
  unidadFiscalizable: string;
  sector: string;
  resolucion: string;
}
