import * as cheerio from 'cheerio';
import type { DocumentMetadata, ParseResult, DocumentRecord, DownloadParams } from '../types/index.js';
import { SELECTORS } from '../utils/constants.js';

export function parsePageMetadata(html: string, pageIndex: number): ParseResult {
  const $ = cheerio.load(html);
  const docs: DocumentMetadata[] = [];

  $(SELECTORS.DATA_ROWS).each((_i, row) => {
    const cells = $(row).find('td[role="gridcell"]');
    if (cells.length < 6) return;

    const nro = $(cells[0]).text().trim();
    const expediente = $(cells[1]).text().trim();
    const title = $(cells[2]).text().trim();
    const date = $(cells[4]).text().trim();

    if (!expediente) return;

    const downloadLink = $(row).find(SELECTORS.DOWNLOAD_LINK);
    let downloadParams: DownloadParams | undefined;
    let fileUrl = '';

    const onclick = downloadLink.attr('onclick') || '';
    const uuidMatch = onclick.match(/param_uuid[^:]*:'([^']+)'/);
    const uuid = uuidMatch ? uuidMatch[1] : '';

    const cmdMatch = onclick.match(/'([^']+?:j_idt63)'/);
    const cmdLink = cmdMatch ? cmdMatch[1] : '';

    if (uuid && cmdLink) {
      downloadParams = { commandLink: cmdLink, uuid };
      fileUrl = JSON.stringify(downloadParams);
    }

    const year = extractYear(expediente) || extractYear(date);

    docs.push({
      id: normalizeId(`${expediente}_${nro}`.trim()),
      expediente,
      title,
      date: $(cells[5]).text().trim(),
      fileUrl,
      fileYear: year,
      sourcePage: pageIndex,
      downloadParams,
    });
  });

  return {
    docs,
    totalRecordsOnPage: docs.length,
    hasMoreData: docs.length > 0,
  };
}

export function extractFileUrl(
  anchorElement: cheerio.Cheerio<any>,
  baseUrl: string,
): string {
  const href = anchorElement.attr('href') || '';
  if (href.startsWith('http://') || href.startsWith('https://')) {
    return href;
  }
  const base = baseUrl.replace(/\/[^/]*$/, '/');
  return base + href.replace(/^\.?\//, '');
}

export function extractYear(dateStr: string): number {
  const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);
  return yearMatch ? parseInt(yearMatch[0], 10) : new Date().getFullYear();
}

export function normalizeId(rawId: string): string {
  return rawId.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function toDocumentRecords(
  docs: DocumentMetadata[],
): DocumentRecord[] {
  return docs.map(doc => ({
    id: doc.id,
    title: doc.title,
    expediente: doc.expediente,
    fileUrl: doc.fileUrl,
    fileYear: doc.fileYear,
    filePath: null,
    status: 'PENDING' as const,
    retryCount: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

export function extractUuidFromHtml(html: string): { uuid: string; commandLink: string } | null {
  const $ = cheerio.load(html);
  const downloadLink = $(SELECTORS.DOWNLOAD_LINK).first();
  const onclick = downloadLink.attr('onclick') || '';

  const uuidMatch = onclick.match(/param_uuid[^:]*:'([^']+)'/);
  const cmdMatch = onclick.match(/'([^']+?:j_idt63)'/);

  if (uuidMatch && cmdMatch) {
    return { uuid: uuidMatch[1], commandLink: cmdMatch[1] };
  }
  return null;
}

export function getExpedienteFromHtml(html: string): string | null {
  const $ = cheerio.load(html);
  const expediente = $(SELECTORS.CELL_EXPEDIENTE).first().text().trim();
  return expediente || null;
}
