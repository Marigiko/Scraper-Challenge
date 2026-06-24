import dotenv from 'dotenv';
dotenv.config();

import * as cheerio from 'cheerio';
import { createSessionClient, fetchInitialHandshake, getSessionClient, getCurrentState, updateStateFromResponse } from './agents/session-manager.js';
import { initializeDatabase, closeDatabase } from './agents/state-tracker.js';
import path from 'node:path';
import type { SessionConfig } from './types/index.js';

const targetUrl = process.env.TARGET_URL || 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';

async function sniff() {
  const sessionConfig: SessionConfig = {
    targetUrl, fallbackUrl: targetUrl, timeout: 30000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };

  initializeDatabase(path.join('./data', 'test.db'));
  createSessionClient(sessionConfig);
  await fetchInitialHandshake(targetUrl);

  // Step 2: Search POST
  const client = getSessionClient();
  let state = getCurrentState();

  const searchPayload = new URLSearchParams();
  searchPayload.append('listarDetalleInfraccionRAAForm', 'listarDetalleInfraccionRAAForm');
  searchPayload.append('listarDetalleInfraccionRAAForm:btnBuscar', 'Buscar');
  searchPayload.append('javax.faces.ViewState', state.viewState);
  searchPayload.append('javax.faces.source', 'listarDetalleInfraccionRAAForm:btnBuscar');

  const searchResp = await client.post(targetUrl, searchPayload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  });

  updateStateFromResponse(searchResp.data);
  state = getCurrentState();
  console.log(`Search OK. ViewState: ${state.viewState.substring(0, 40)}...\n`);

  // Step 3: Try PrimeFaces pagination to page 2
  console.log('=== PAGE 2 via PrimeFaces AJAX ===');
  const page2Payload = new URLSearchParams();
  page2Payload.append('listarDetalleInfraccionRAAForm', 'listarDetalleInfraccionRAAForm');
  page2Payload.append('listarDetalleInfraccionRAAForm:dt_pagination', '1');   // 0-indexed page
  page2Payload.append('javax.faces.ViewState', state.viewState);
  page2Payload.append('javax.faces.source', 'listarDetalleInfraccionRAAForm:dt');
  page2Payload.append('javax.faces.partial.event', 'page');
  page2Payload.append('javax.faces.partial.execute', 'listarDetalleInfraccionRAAForm:dt');
  page2Payload.append('javax.faces.partial.render', 'listarDetalleInfraccionRAAForm:dt listarDetalleInfraccionRAAForm:dt_paginator_bottom');
  page2Payload.append('javax.faces.ClientWindow', '');

  try {
    const page2Resp = await client.post(targetUrl, page2Payload.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Faces-Request': 'partial/ajax',
        'Accept': 'application/xml, text/xml, */*',
      },
    });

    const respData = typeof page2Resp.data === 'string' ? page2Resp.data : String(page2Resp.data);
    console.log(`Status: ${page2Resp.status}`);
    console.log(`Response (first 300): ${respData.substring(0, 300)}\n`);

    // Try to parse PrimeFaces XML partial response
    if (respData.includes('<?xml') || respData.includes('<partial-response')) {
      // Extract CDATA content
      const cdataMatch = respData.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
      if (cdataMatch) {
        const innerHtml = cdataMatch[1];
        const $ = cheerio.load(innerHtml);
        const rows = $('tr.ui-widget-content');
        console.log(`Rows in response: ${rows.length}`);
        rows.each((i, row) => {
          const cells = $(row).find('td');
          const texts = cells.map((_j, c) => $(c).text().trim()).get();
          console.log(`  ${i}: ${texts[0]} | ${texts[1]}`);
        });
      }
    } else {
      // Non-AJAX response — check page info
      const $ = cheerio.load(respData);
      const rows = $('tr.ui-widget-content');
      console.log(`Rows: ${rows.length}`);
      const currentPage = $('.ui-paginator-page.ui-state-active').text().trim();
      console.log(`Current page shown: ${currentPage}`);
    }
  } catch (err: any) {
    console.log(`Pagination attempt failed: ${err.message}`);
  }

  // Step 4: Try full POST for page 2 (non-AJAX)
  console.log('\n=== PAGE 2 via FULL POST ===');
  const page2bPayload = new URLSearchParams();
  page2bPayload.append('listarDetalleInfraccionRAAForm', 'listarDetalleInfraccionRAAForm');
  page2bPayload.append('listarDetalleInfraccionRAAForm:dt_pagination', '1');
  page2bPayload.append('javax.faces.ViewState', state.viewState);

  const page2bResp = await client.post(targetUrl, page2bPayload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  });

  const page2bHtml = typeof page2bResp.data === 'string' ? page2bResp.data : String(page2bResp.data);
  const $2 = cheerio.load(page2bHtml);
  const rows2 = $2('tr.ui-widget-content');
  console.log(`Rows: ${rows2.length}`);
  const activePage = $2('.ui-paginator-page.ui-state-active').text().trim();
  console.log(`Active page: ${activePage}`);
  if (rows2.length > 0) {
    rows2.each((i, row) => {
      const cells = $2(row).find('td');
      console.log(`  ${i}: ${$2(cells[0]).text().trim()} | ${$2(cells[1]).text().trim()}`);
    });
  }

  // Step 5: Download a PDF
  console.log('\n=== PDF DOWNLOAD TEST ===');
  const searchResp2 = await client.post(targetUrl, searchPayload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  });
  updateStateFromResponse(searchResp2.data);
  state = getCurrentState();

  const $$ = cheerio.load(typeof searchResp2.data === 'string' ? searchResp2.data : String(searchResp2.data));
  const firstDownloadLink = $$('tr.ui-widget-content').first().find('a[onclick]');
  const onclick = firstDownloadLink.attr('onclick') || '';
  console.log(`First download onclick: ${onclick.substring(0, 300)}`);

  // Try to submit the form via mojarra.jsfcljs simulation
  // Extract parameters from the onclick
  const paramMatch = onclick.match(/\{'([^']+)':'([^']+)','([^']+)':'([^')]+)'\}/);
  if (paramMatch) {
    console.log(`Extracted params: ${paramMatch[1]}=${paramMatch[2]}, ${paramMatch[3]}=${paramMatch[4]}`);

    const dlPayload = new URLSearchParams();
    dlPayload.append('listarDetalleInfraccionRAAForm', 'listarDetalleInfraccionRAAForm');
    dlPayload.append(paramMatch[1], paramMatch[2]);
    dlPayload.append(paramMatch[3], paramMatch[4]);
    dlPayload.append('javax.faces.ViewState', state.viewState);

    try {
      const dlResp = await client.post(targetUrl, dlPayload.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        responseType: 'arraybuffer',
        validateStatus: (s) => s < 400,
      });

      const contentType = dlResp.headers['content-type'] || '';
      console.log(`Download status: ${dlResp.status}`);
      console.log(`Content-Type: ${contentType}`);
      console.log(`Content-Length: ${dlResp.data?.byteLength || 0} bytes`);
    } catch (err: any) {
      console.log(`Download failed: ${err.message}`);
      if (err.response) {
        console.log(`Status: ${err.response.status}, Type: ${err.response.headers?.['content-type'] || 'N/A'}`);
      }
    }
  }

  closeDatabase();
  console.log('\nDone.');
}

sniff().catch(err => { console.error(err?.message || err); try { closeDatabase(); } catch {} process.exit(1); });
