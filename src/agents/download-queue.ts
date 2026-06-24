import { mkdirSync } from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import type { AxiosInstance } from 'axios';
import type { DocumentMetadata, DownloadResult, QueueConfig } from '../types/index.js';
import { updateDocumentStatus, logDeadLetter } from './state-tracker.js';
import { handleFailure, sleep } from './resilience-manager.js';
import { downloadJsfFile } from '../utils/download-stream.js';
import { JSF_CONSTANTS, SELECTORS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

const targetUrl = process.env.TARGET_URL || 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';

class DownloadQueue {
  private maxConcurrency: number;
  private downloadDir: string;
  private client: AxiosInstance | null = null;
  private viewState: string = '';
  private initPromise: Promise<void> | null = null;
  private queue: DocumentMetadata[] = [];
  private activeWorkers: number = 0;
  private completedCount: number = 0;
  private failedCount: number = 0;
  private isPaused: boolean = false;
  private isShuttingDown: boolean = false;
  private resolveDrain: (() => void) | null = null;
  private drainRejected: boolean = false;

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
        logger.info(`Download queue drained. Completed: ${this.completedCount}, Failed: ${this.failedCount}`);
        resolve([]);
      };
    });
  }

  private ensureSession(): Promise<void> {
    if (this.client) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.createSession();
    return this.initPromise;
  }

  private async createSession(): Promise<void> {
    const jar = new CookieJar();
    const client = wrapper(axios.create({
      jar,
      withCredentials: true,
      timeout: Number(process.env.REQUEST_TIMEOUT_MS) || 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
      },
      maxRedirects: 5,
    }));

    const resp = await client.get(targetUrl);
    const $ = cheerio.load(resp.data);
    this.viewState = $(SELECTORS.VIEW_STATE).val() as string || '';
    this.client = client;
    logger.info('Download session created');
  }

  private async drain(): Promise<void> {
    if (this.drainRejected) return;

    try {
      await this.ensureSession();
    } catch (error: any) {
      logger.error(`Failed to create download session: ${error.message}`);
      this.initPromise = null;
      this.drainRejected = true;
      return;
    }

    // Process items even when shutting down (to drain remaining)
    while (this.activeWorkers < this.maxConcurrency && this.queue.length > 0 && !this.isPaused) {
      const item = this.queue.shift()!;
      this.activeWorkers++;
      this.processItem(item).finally(() => {
        this.activeWorkers--;
        if (this.activeWorkers === 0 && this.queue.length === 0) {
          this.resolveDrain?.();
        } else if (this.queue.length > 0) {
          this.drain();
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
    const timeout = Number(process.env.REQUEST_TIMEOUT_MS) || 30000;

    try {
      updateDocumentStatus(doc.id, 'DOWNLOADING');

      if (!doc.downloadParams) {
        throw new Error(`No download parameters for ${doc.id}`);
      }

      if (!this.client) {
        throw new Error('Download client not initialized');
      }

      const success = await downloadJsfFile(
        this.client,
        targetUrl,
        JSF_CONSTANTS.FORM_ID,
        this.viewState,
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
