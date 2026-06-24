import { getSessionClient } from './session-manager.js';
import { updateStateFromResponse } from './session-manager.js';
import { JSF_CONSTANTS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

export async function searchByExpediente(
  expediente: string,
  targetUrl: string,
  viewState: string,
): Promise<string> {
  const client = getSessionClient();

  const payload = new URLSearchParams();
  payload.append(JSF_CONSTANTS.FORM_ID, JSF_CONSTANTS.FORM_ID);
  payload.append(JSF_CONSTANTS.EXPEDIENTE_FIELD, expediente);
  payload.append(JSF_CONSTANTS.SEARCH_BUTTON, 'Buscar');
  payload.append('javax.faces.ViewState', viewState);
  payload.append('javax.faces.source', JSF_CONSTANTS.SEARCH_BUTTON);

  logger.debug(`Searching expediente: ${expediente.substring(0, 30)}...`);

  const response = await client.post(targetUrl, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  });

  const rawHtml = typeof response.data === 'string' ? response.data : String(response.data);
  updateStateFromResponse(rawHtml);
  return rawHtml;
}

export async function fetchAllPageHtml(
  targetUrl: string,
  viewState: string,
): Promise<string> {
  const client = getSessionClient();

  const payload = new URLSearchParams();
  payload.append(JSF_CONSTANTS.FORM_ID, JSF_CONSTANTS.FORM_ID);
  payload.append(JSF_CONSTANTS.SEARCH_BUTTON, 'Buscar');
  payload.append('javax.faces.ViewState', viewState);
  payload.append('javax.faces.source', JSF_CONSTANTS.SEARCH_BUTTON);

  const response = await client.post(targetUrl, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  });

  const rawHtml = typeof response.data === 'string' ? response.data : String(response.data);
  updateStateFromResponse(rawHtml);
  return rawHtml;
}

export async function exportToExcel(
  targetUrl: string,
  viewState: string,
): Promise<Buffer | null> {
  const client = getSessionClient();

  const payload = new URLSearchParams();
  payload.append(JSF_CONSTANTS.FORM_ID, JSF_CONSTANTS.FORM_ID);
  payload.append(JSF_CONSTANTS.EXPORT_BUTTON, JSF_CONSTANTS.EXPORT_BUTTON);
  payload.append('javax.faces.ViewState', viewState);
  payload.append('javax.faces.source', JSF_CONSTANTS.EXPORT_BUTTON);

  const response = await client.post(targetUrl, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    responseType: 'arraybuffer',
    validateStatus: (s) => s < 400,
  });

  const ct = String(response.headers['content-type'] || '');
  const len = response.data?.byteLength || 0;

  if (len > 0 && (ct.includes('excel') || ct.includes('spreadsheet') || ct.includes('octet-stream'))) {
    logger.info(`Excel export: ${len} bytes`);
    return Buffer.from(response.data);
  }

  logger.warn(`Excel export returned unexpected content: ${ct} (${len} bytes)`);
  return null;
}
