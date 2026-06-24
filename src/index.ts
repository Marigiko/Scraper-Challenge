import dotenv from 'dotenv';
dotenv.config();

import path from 'node:path';
import type { OrchestratorConfig, SessionConfig, DocumentMetadata } from './types/index.js';
import { initializeDatabase, getCheckpoint, saveCheckpoint, upsertDocumentsBatch, getPendingDocuments, closeDatabase } from './agents/state-tracker.js';
import { createSessionClient, fetchInitialHandshake, getCurrentState, updateStateFromAjaxResponse } from './agents/session-manager.js';
import { fetchPageViaAjax, fetchAllPageHtml } from './agents/pagination-crawler.js';
import { parsePageMetadata, parseAjaxResponse, toDocumentRecords, toDocumentMetadata } from './agents/document-parser.js';
import { createQueue } from './agents/download-queue.js';
import { openJsonlStream, appendJsonl, closeJsonlStream } from './utils/jsonl.js';
import { logger } from './utils/logger.js';

let isShuttingDown = false;

export async function runCrawler(config: OrchestratorConfig): Promise<void> {
  const sessionConfig: SessionConfig = {
    targetUrl: config.targetUrl,
    fallbackUrl: process.env.FALLBACK_URL || config.targetUrl,
    timeout: Number(process.env.REQUEST_TIMEOUT_MS) || 30000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };

  const dbPath = path.join(config.dataDir, 'scraper.db');
  initializeDatabase(dbPath);
  createSessionClient(sessionConfig);

  const checkpoint = getCheckpoint();
  let startPage = 0;
  if (checkpoint && checkpoint.viewState && checkpoint.lastPageProcessed > 0 && checkpoint.lastPageProcessed < 200) {
    startPage = checkpoint.lastPageProcessed;
    logger.info(`Resuming from page ${startPage + 1}`);
  } else {
    logger.info('Starting fresh.');
  }

  const handshake = await fetchInitialHandshake(config.targetUrl);
  logger.info(`Handshake complete. Status: ${handshake.status}`);

  const jsonlPath = path.join(config.dataDir, 'metadata.jsonl');
  openJsonlStream(jsonlPath);

  const downloadQueue = createQueue({
    minConcurrency: 2,
    maxConcurrency: config.concurrency,
    downloadDir: config.downloadDir,
  });

  setupSignalHandlers(downloadQueue);

  // --- Phase 1: Pagination (all metadata) ---
  try {
    logger.info('Running initial search to populate data table...');
    const searchHtml = await fetchAllPageHtml(config.targetUrl, getCurrentState().viewState);

    let totalDocsProcessed = 0;
    let pageSize = 0;

    const page0Docs = parsePageMetadata(searchHtml, 0);
    if (page0Docs.docs.length === 0) {
      logger.warn('No records found on initial search, aborting.');
      await performShutdown(downloadQueue);
      return;
    }

    pageSize = page0Docs.docs.length;

    if (startPage === 0) {
      const records = toDocumentRecords(page0Docs.docs);
      upsertDocumentsBatch(records);
      appendJsonl(page0Docs.docs);

      totalDocsProcessed += page0Docs.docs.length;
      saveCheckpoint(0, getCurrentState().viewState);
      logger.info(`Page 1: ${page0Docs.docs.length} records`);
    }

    const totalRecords = 1753;
    const totalPages = Math.ceil(totalRecords / pageSize);
    logger.info(`Detected ${pageSize} records/page, ${totalPages} pages expected`);

    for (let page = Math.max(1, startPage); page < totalPages; page++) {
      if (isShuttingDown) break;

      try {
        const state = getCurrentState();
        const xml = await fetchPageViaAjax(config.targetUrl, state.viewState, page);
        updateStateFromAjaxResponse(xml);

        const { docs, newViewState } = parseAjaxResponse(xml, page);
        if (docs.length === 0) {
          logger.info(`Page ${page + 1} returned no records, stopping (all collected)`);
          break;
        }

        const records = toDocumentRecords(docs);
        upsertDocumentsBatch(records);
        appendJsonl(docs);

        totalDocsProcessed += docs.length;
        const vs = newViewState ?? state.viewState;
        saveCheckpoint(page, vs);

        if ((page + 1) % 20 === 0 || page === totalPages - 1) {
          logger.info(`Progress: page ${page + 1}/${totalPages} (${totalDocsProcessed} total records)`);
          const mem = process.memoryUsage();
          logger.info(`Memory: heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
        }
      } catch (error: any) {
        logger.error(`Failed to fetch page ${page + 1}: ${error.message}`);
        continue;
      }
    }

    logger.info(`Pagination complete. ${totalDocsProcessed} metadata records collected.`);
  } catch (error: any) {
    logger.error(`Crawl error: ${error.message}`);
    throw error;
  }

  // --- Phase 2: Downloads ---
  if (!config.dryRun) {
    logger.info('Starting download phase...');
    const pending = getPendingDocuments();
    const allDocs: DocumentMetadata[] = pending.map(toDocumentMetadata);
    logger.info(`Enqueuing ${allDocs.length} documents for download...`);
    for (const doc of allDocs) {
      if (isShuttingDown) break;
      downloadQueue.enqueueDownload(doc);
    }
    logger.info('All downloads enqueued. Draining queue...');
  }

  await performShutdown(downloadQueue);
}

async function performShutdown(downloadQueue: ReturnType<typeof createQueue>): Promise<void> {
  logger.info('Shutting down...');

  try {
    await downloadQueue.shutdownQueue();
  } catch (error: any) {
    logger.error(`Error draining download queue: ${error.message}`);
  }

  closeJsonlStream();
  closeDatabase();
  logger.info('Shutdown complete.');
}

function setupSignalHandlers(downloadQueue: ReturnType<typeof createQueue>): void {
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Signal received. Draining active downloads...');

    try {
      await downloadQueue.shutdownQueue();
    } catch (error: any) {
      logger.error(`Error during signal shutdown: ${error.message}`);
    }

    closeJsonlStream();
    closeDatabase();
    logger.info('Graceful shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err: err.message, stack: err.stack });
    closeJsonlStream();
    closeDatabase();
    process.exit(1);
  });
}

const defaultConfig: OrchestratorConfig = {
  targetUrl: process.env.TARGET_URL || 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml',
  downloadDir: process.env.DOWNLOAD_DIR || './downloads',
  dataDir: process.env.DATA_DIR || './data',
  concurrency: Number(process.env.CONCURRENCY_MAX) || 3,
  retryPolicy: {
    maxRetries: Number(process.env.MAX_RETRIES) || 5,
    baseDelayMs: Number(process.env.BASE_DELAY_MS) || 1000,
    maxDelayMs: Number(process.env.MAX_DELAY_MS) || 60000,
    jitterFactor: Number(process.env.JITTER_FACTOR) || 0.25,
  },
  dryRun: process.argv.includes('--dry-run'),
};

runCrawler(defaultConfig).catch((err) => {
  logger.error('Fatal error', { err: err.message, stack: err.stack });
  closeDatabase();
  process.exit(1);
});
