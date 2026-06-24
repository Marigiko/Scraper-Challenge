import dotenv from 'dotenv';
dotenv.config();

import path from 'node:path';
import XLSX from 'xlsx';
import type { OrchestratorConfig, SessionConfig, DocumentMetadata, ExportRecord } from './types/index.js';
import { initializeDatabase, getCheckpoint, saveCheckpoint, upsertDocumentsBatch, isDocumentCompleted, closeDatabase } from './agents/state-tracker.js';
import { createSessionClient, fetchInitialHandshake, getCurrentState } from './agents/session-manager.js';
import { searchByExpediente, exportToExcel, fetchAllPageHtml } from './agents/pagination-crawler.js';
import { toDocumentRecords, extractUuidFromHtml } from './agents/document-parser.js';
import { createQueue } from './agents/download-queue.js';
import { openJsonlStream, appendJsonl, closeJsonlStream } from './utils/jsonl.js';
import { logger } from './utils/logger.js';

let isShuttingDown = false;

function parseExportData(buffer: Buffer): ExportRecord[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1 });

  const records: ExportRecord[] = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row && row.length >= 6) {
      records.push({
        nro: String(row[0] ?? '').trim(),
        expediente: String(row[1] ?? '').trim(),
        administrado: String(row[2] ?? '').trim(),
        unidadFiscalizable: String(row[3] ?? '').trim(),
        sector: String(row[4] ?? '').trim(),
        resolucion: String(row[5] ?? '').trim(),
      });
    }
  }
  return records;
}

function extractYear(expediente: string, resolucion: string): number {
  const yearMatch = (expediente + ' ' + resolucion).match(/\b(19|20)\d{2}\b/);
  return yearMatch ? parseInt(yearMatch[0], 10) : new Date().getFullYear();
}

function normalizeId(rawId: string): string {
  return rawId.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

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
  let processedCount = 0;
  if (checkpoint && checkpoint.viewState) {
    processedCount = checkpoint.lastPageProcessed;
    logger.info(`Resuming from ${processedCount} previously processed expedientes`);
  } else {
    logger.info('No checkpoint found. Starting fresh.');
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

  try {
    logger.info('Running initial search to populate data table...');
    await fetchAllPageHtml(config.targetUrl, getCurrentState().viewState);
    logger.info('Search complete. Now exporting all records to Excel...');

    const excelBuffer = await exportToExcel(config.targetUrl, getCurrentState().viewState);

    if (!excelBuffer) {
      throw new Error('Excel export failed - received unexpected content');
    }

    const exportRecords = parseExportData(excelBuffer);
    logger.info(`Parsed ${exportRecords.length} records from Excel export`);

    const batchSize = 10;
    let recordsProcessed = 0;

    for (let i = 0; i < exportRecords.length; i += batchSize) {
      if (isShuttingDown) break;

      const batch = exportRecords.slice(i, i + batchSize);

      for (const exp of batch) {
        if (isShuttingDown) break;
        if (isDocumentCompleted(normalizeId(`${exp.expediente}_${exp.nro}`))) {
          recordsProcessed++;
          continue;
        }

        try {
          const state = getCurrentState();
          const html = await searchByExpediente(exp.expediente, config.targetUrl, state.viewState);

          const uuidData = extractUuidFromHtml(html);
          if (!uuidData) {
            logger.warn(`No download link for expediente: ${exp.expediente} (confidential or unavailable)`);
            recordsProcessed++;
            continue;
          }

          const year = extractYear(exp.expediente, exp.resolucion);
          const docId = normalizeId(`${exp.expediente}_${exp.nro}`);

          const doc: DocumentMetadata = {
            id: docId,
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

          if (!config.dryRun) {
            downloadQueue.enqueueDownload(doc);
          }

          recordsProcessed++;
          saveCheckpoint(recordsProcessed, getCurrentState().viewState);

          if (recordsProcessed % 50 === 0) {
            logger.info(`Progress: ${recordsProcessed}/${exportRecords.length} expedientes processed`);
            const mem = process.memoryUsage();
            logger.info(`Memory: heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
          }
        } catch (error: any) {
          logger.error(`Failed to process expediente ${exp.expediente}: ${error.message}`);
          recordsProcessed++;
          continue;
        }
      }
    }

    logger.info(`Processed ${recordsProcessed}/${exportRecords.length} records. Draining download queue...`);
  } catch (error: any) {
    logger.error(`Crawl error: ${error.message}`);
    throw error;
  } finally {
    await performShutdown(downloadQueue);
  }
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
