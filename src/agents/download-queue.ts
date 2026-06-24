import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DocumentMetadata, DownloadResult, QueueConfig } from '../types/index.js';
import { updateDocumentStatus, logDeadLetter } from './state-tracker.js';
import { handleFailure, sleep } from './resilience-manager.js';
import { downloadJsfFile } from '../utils/download-stream.js';
import { getSessionClient, getCurrentState } from './session-manager.js';
import { JSF_CONSTANTS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

const targetUrl = process.env.TARGET_URL || 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';

class DownloadQueue {
  private maxConcurrency: number;
  private downloadDir: string;
  private queue: DocumentMetadata[] = [];
  private activeWorkers: number = 0;
  private completedCount: number = 0;
  private failedCount: number = 0;
  private isPaused: boolean = false;
  private isShuttingDown: boolean = false;
  private resolveDrain: (() => void) | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(config: QueueConfig) {
    this.maxConcurrency = config.maxConcurrency;
    this.downloadDir = config.downloadDir;
  }

  enqueueDownload(target: DocumentMetadata): void {
    if (this.isShuttingDown) return;
    this.queue.push(target);
    this.drain();
  }

  shutdownQueue(): Promise<DownloadResult[]> {
    this.isShuttingDown = true;
    if (this.activeWorkers === 0 && this.queue.length === 0) {
      return Promise.resolve([]);
    }
    return new Promise(resolve => {
      this.resolveDrain = () => {
        const results: DownloadResult[] = [];
        logger.info(`Download queue drained. Completed: ${this.completedCount}, Failed: ${this.failedCount}`);
        resolve(results);
      };
    });
  }

  getQueueStats() {
    return {
      activeWorkers: this.activeWorkers,
      pendingItems: this.queue.length,
      completedCount: this.completedCount,
      failedCount: this.failedCount,
    };
  }

  waitForDrain(): Promise<void> {
    if (this.activeWorkers === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    if (!this.drainPromise) {
      this.drainPromise = new Promise(resolve => {
        this.resolveDrain = resolve;
      });
    }
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    while (this.activeWorkers < this.maxConcurrency && this.queue.length > 0 && !this.isPaused && !this.isShuttingDown) {
      const item = this.queue.shift()!;
      this.activeWorkers++;
      this.processItem(item).finally(() => {
        this.activeWorkers--;
        if (this.activeWorkers === 0 && this.queue.length === 0) {
          this.drainPromise = null;
          this.resolveDrain?.();
        }
      });
    }
  }

  private async processItem(doc: DocumentMetadata): Promise<void> {
    const startTime = Date.now();
    const destDir = path.join(this.downloadDir, String(doc.fileYear));
    const destPath = path.join(destDir, `${doc.id}.pdf`);

    try {
      mkdirSync(destDir, { recursive: true });
    } catch {
      // directory may already exist
    }

    const result = await this.attemptDownload(doc, destPath, startTime);

    if (result.success) {
      this.completedCount++;
      updateDocumentStatus(doc.id, 'COMPLETED');
    } else {
      this.failedCount++;
    }
  }

  private async attemptDownload(
    doc: DocumentMetadata,
    destPath: string,
    startTime: number,
    attempt: number = 0,
  ): Promise<DownloadResult> {
    const client = getSessionClient();
    const timeout = Number(process.env.REQUEST_TIMEOUT_MS) || 30000;

    try {
      updateDocumentStatus(doc.id, 'DOWNLOADING');

      if (!doc.downloadParams) {
        throw new Error(`No download parameters for ${doc.id}`);
      }
      const state = getCurrentState();
      const success = await downloadJsfFile(
        client,
        targetUrl,
        JSF_CONSTANTS.FORM_ID,
        state.viewState,
        doc.downloadParams,
        destPath,
        timeout,
      );

      if (success) {
        const durationMs = Date.now() - startTime;
        logger.info(`Downloaded ${doc.id} -> ${destPath} (${durationMs}ms)`);
        return {
          success: true,
          docId: doc.id,
          filePath: destPath,
          error: null,
          attempts: attempt + 1,
          durationMs,
        };
      }

      throw new Error('Download stream completed but file may be incomplete');
    } catch (error: any) {
      const statusCode = error.response?.status ?? null;
      const retryAfter = error.response?.headers?.['retry-after']
        ? parseInt(error.response.headers['retry-after'], 10)
        : null;

      const failureCtx = {
        docId: doc.id,
        pageIndex: doc.sourcePage,
        url: doc.fileUrl,
        attempt,
        statusCode,
        errorMessage: error.message || 'Unknown error',
        retryAfter,
      };

      const backoffResult = handleFailure(failureCtx);

      if (backoffResult.isFinalAttempt) {
        logDeadLetter({
          docId: doc.id,
          pageIndex: doc.sourcePage,
          url: doc.fileUrl,
          error: error.message || 'Unknown error',
          retryAttempts: attempt + 1,
          createdAt: new Date().toISOString(),
        });

        updateDocumentStatus(doc.id, 'FAILED', `${error.message} (attempt ${attempt + 1})`);

        return {
          success: false,
          docId: doc.id,
          filePath: null,
          error: error.message || 'Unknown error',
          attempts: attempt + 1,
          durationMs: Date.now() - startTime,
        };
      }

      if (backoffResult.delayMs > 0) {
        this.isPaused = true;
        logger.info(`Pausing queue for ${backoffResult.delayMs}ms (429 backoff)`);
        await sleep(backoffResult.delayMs);
        this.isPaused = false;
        this.drain();
      }

      return this.attemptDownload(doc, destPath, startTime, attempt + 1);
    }
  }
}

export function createQueue(config: QueueConfig): DownloadQueue {
  return new DownloadQueue(config);
}
