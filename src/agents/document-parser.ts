import * as cheerio from 'cheerio';
import type { DocumentMetadata, ParseResult, DocumentRecord, DownloadParams } from '../types/index.js';
import { SELECTORS } from '../utils/constants.js';

export function parsePageMetadata(html: string, pageIndex: number): ParseResult {
  const $ = cheerio.load(html);
  const docs: DocumentMetadata[] = [];

  $(SELECTORS.DATA_ROWS).each((_i, row) => {
    const doc = parseTableRow($, row, pageIndex);
    if (doc) docs.push(doc);
  });

  return {
    docs,
    totalRecordsOnPage: docs.length,
    hasMoreData: docs.length > 0,
  };
}

export function parseAjaxResponse(xml: string, pageIndex: number): {
  docs: DocumentMetadata[];
  newViewState: string | null;
} {
  let newViewState: string | null = null;
  let tableHtml = '';

  const vsMatch = xml.match(/<update id="[^"]*:javax\.faces\.ViewState[^"]*">\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/update>/);
  if (vsMatch) {
    newViewState = vsMatch[1].trim();
  }

  const tableMatch = xml.match(/<update id="listarDetalleInfraccionRAAForm:dt">\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/update>/);
  if (tableMatch) {
    tableHtml = tableMatch[1];
  }

  const docs: DocumentMetadata[] = [];
  if (!tableHtml) return { docs, newViewState };

  const $ = cheerio.load(`<table><tbody>${tableHtml}</tbody></table>`);
  $(SELECTORS.DATA_ROWS).each((_i, row) => {
    const doc = parseTableRow($, row, pageIndex);
    if (doc) docs.push(doc);
  });

  return { docs, newViewState };
}

function parseTableRow($: cheerio.CheerioAPI, row: any, pageIndex: number): DocumentMetadata | null {
  const cells = $(row).find('td[role="gridcell"]');
  if (cells.length < 6) return null;

  const nro = $(cells[0]).text().trim();
  const expediente = $(cells[1]).text().trim();
  const administrado = $(cells[2]).text().trim();
  const resolucion = cells.length >= 6 ? $(cells[5]).text().trim() : '';

  if (!expediente && !nro) return null;

  const downloadLink = $(row).find(SELECTORS.DOWNLOAD_LINK);
  const onclick = downloadLink.attr('onclick') || '';
  let downloadParams: DownloadParams | undefined;
  let fileUrl = '';

  const uuidMatch = onclick.match(/param_uuid[^:]*:'([^']+)'/);
  const uuid = uuidMatch ? uuidMatch[1] : '';
  const cmdMatch = onclick.match(/'([^']+?:j_idt63)'/);
  const cmdLink = cmdMatch ? cmdMatch[1] : '';

  if (uuid && cmdLink) {
    downloadParams = { commandLink: cmdLink, uuid };
    fileUrl = JSON.stringify(downloadParams);
  }

  const year = extractYear(expediente) || extractYear(resolucion);

  return {
    id: normalizeId(`${expediente}_${nro}`.trim()),
    expediente,
    title: administrado,
    date: resolucion,
    fileUrl,
    fileYear: year,
    sourcePage: pageIndex,
    downloadParams,
  };
}

function extractYear(dateStr: string): number {
  const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);
  return yearMatch ? parseInt(yearMatch[0], 10) : new Date().getFullYear();
}

function normalizeId(rawId: string): string {
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

export function toDocumentMetadata(rec: DocumentRecord): DocumentMetadata {
  let downloadParams: DownloadParams | undefined;
  try {
    const parsed = JSON.parse(rec.fileUrl);
    if (parsed && parsed.commandLink && parsed.uuid) {
      downloadParams = { commandLink: parsed.commandLink, uuid: parsed.uuid };
    }
  } catch {
    // fileUrl is not JSON — leave downloadParams undefined
  }

  return {
    id: rec.id,
    expediente: rec.expediente,
    title: rec.title,
    date: '',
    fileUrl: rec.fileUrl,
    fileYear: rec.fileYear,
    sourcePage: 0,
    downloadParams,
  };
}


