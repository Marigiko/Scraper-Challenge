import dotenv from 'dotenv';
dotenv.config();

import * as cheerio from 'cheerio';
import { createSessionClient, fetchInitialHandshake, getSessionClient, getCurrentState, updateStateFromResponse } from './agents/session-manager.js';
import { initializeDatabase, closeDatabase } from './agents/state-tracker.js';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import type { SessionConfig } from './types/index.js';

const targetUrl = process.env.TARGET_URL || 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';
const FORM_ID = 'listarDetalleInfraccionRAAForm';

function buildBody(params: Record<string, string>): string {
  return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function main() {
  const sessionConfig: SessionConfig = {
    targetUrl, fallbackUrl: targetUrl, timeout: 60000,
    userAgent: 'Mozilla/5.0 ...',
  };

  initializeDatabase(path.join('./data', 'test.db'));
  createSessionClient(sessionConfig);
  await fetchInitialHandshake(targetUrl);
  const client = getSessionClient();
  let state = getCurrentState();

  // Search
  const searchBody = buildBody({
    [FORM_ID]: FORM_ID,
    [`${FORM_ID}:btnBuscar`]: 'Buscar',
    'javax.faces.ViewState': state.viewState,
    'javax.faces.source': `${FORM_ID}:btnBuscar`,
  });
  const sr = await client.post(targetUrl, searchBody, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  });
  updateStateFromResponse(sr.data);
  state = getCurrentState();

  // Try Excel export
  console.log('=== Excel Export Attempt ===');
  const exportBody = buildBody({
    [FORM_ID]: FORM_ID,
    [`${FORM_ID}:dt:j_idt38`]: `${FORM_ID}:dt:j_idt38`,
    'javax.faces.ViewState': state.viewState,
    'javax.faces.source': `${FORM_ID}:dt:j_idt38`,
  });

  try {
    const exportResp = await client.post(targetUrl, exportBody, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      responseType: 'arraybuffer',
      validateStatus: (s) => s < 400,
    });

    const ct = String(exportResp.headers['content-type'] || '');
    const len = exportResp.data?.byteLength || 0;
    console.log(`Export status: ${exportResp.status}`);
    console.log(`Content-Type: ${ct}`);
    console.log(`Content-Length: ${len} bytes`);

    if (len > 0 && (ct.includes('excel') || ct.includes('spreadsheet') || ct.includes('octet-stream'))) {
      writeFileSync('data/export.xls', Buffer.from(exportResp.data));
      console.log('Saved to data/export.xls');
    } else {
      const text = Buffer.from(exportResp.data).toString('utf-8');
      console.log(`Response text (first 300): ${text.substring(0, 300)}`);
    }
  } catch (err: any) {
    console.log(`Export failed: ${err.message}`);
    if (err.response) {
      console.log(`Status: ${err.response.status}, Headers:`, JSON.stringify(err.response.headers));
    }
  }

  // Try making a larger request with all empty search fields
  console.log('\n=== Full search with explicit empty fields ===');
  const fullSearchBody = buildBody({
    [FORM_ID]: FORM_ID,
    [`${FORM_ID}:btnBuscar`]: 'Buscar',
    [`${FORM_ID}:txtNroexp`]: '',
    [`${FORM_ID}:j_idt21`]: '',
    [`${FORM_ID}:j_idt25`]: '',
    [`${FORM_ID}:idsector`]: '',
    [`${FORM_ID}:j_idt34`]: '',
    'javax.faces.ViewState': state.viewState,
    'javax.faces.source': `${FORM_ID}:btnBuscar`,
  });

  const fsr = await client.post(targetUrl, fullSearchBody, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  });
  const $ = cheerio.load(typeof fsr.data === 'string' ? fsr.data : String(fsr.data));
  const rows = $('tr.ui-widget-content');
  const paginatorText = $('.ui-paginator-current').text().trim();
  console.log(`Rows: ${rows.length}`);
  console.log(`Paginator: ${paginatorText}`);

  // Check for any JavaScript array with data
  console.log('\n=== Checking for inline data in JavaScript ===');
  const scripts = $('script').map((_i, s) => $(s).html() || '').get();
  const dataScripts = scripts.filter(s => s.includes('rowCount') || s.includes('total') || s.includes('records'));
  dataScripts.forEach((s, i) => {
    console.log(`Script ${i}: ${s.substring(0, 300)}`);
  });

  // Try to manually extract all expedientes from the page (just in case)
  console.log('\n=== Checking for hidden data ===');
  const expedientes = $('td').map((_i, td) => $(td).text().trim()).get().filter(t => /\d{3,}/.test(t));
  console.log(`All <td> texts (first 20): ${expedientes.slice(0, 20).join(', ')}`);

  closeDatabase();
  console.log('\nDone.');
}

main().catch(err => { console.error(err?.message || err); try { closeDatabase(); } catch {} process.exit(1); });
