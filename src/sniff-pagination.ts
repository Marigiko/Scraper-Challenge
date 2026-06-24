import dotenv from 'dotenv';
dotenv.config();

import * as cheerio from 'cheerio';
import { createSessionClient, fetchInitialHandshake, getCurrentState, updateStateFromResponse } from './agents/session-manager.js';
import { initializeDatabase, closeDatabase } from './agents/state-tracker.js';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import type { SessionConfig } from './types/index.js';
import { searchByExpediente } from './agents/pagination-crawler.js';
import { extractUuidFromHtml } from './agents/document-parser.js';

const targetUrl = process.env.TARGET_URL || 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';

const TEST_EXPEDIENTES = [
  '3739-2009-PRODUCE/DIGSECOVI-Dsvs',
  '3355-2018-OEFA/DFAI/PAS',
  '891-08-PRODUCE/DIGSECOVI-Dsvs',
];

async function main() {
  const sessionConfig: SessionConfig = {
    targetUrl, fallbackUrl: targetUrl, timeout: 30000,
    userAgent: 'Mozilla/5.0 ...',
  };

  initializeDatabase(path.join('./data', 'test.db'));
  createSessionClient(sessionConfig);
  await fetchInitialHandshake(targetUrl);
  let state = getCurrentState();

  for (const exp of TEST_EXPEDIENTES) {
    const html = await searchByExpediente(exp, targetUrl, state.viewState);
    updateStateFromResponse(html);
    state = getCurrentState();
    const $ = cheerio.load(html);
    const rows = $('tr.ui-widget-content');
    const paginatorText = $('.ui-paginator-current').text().trim() || '(none)';

    console.log(`\n=== "${exp}" ===`);
    console.log(`Rows: ${rows.length}, Paginator: "${paginatorText}"`);

    const uuid = extractUuidFromHtml(html);
    if (uuid) {
      console.log(`UUID found: ${uuid.uuid.substring(0, 30)}...`);
    } else {
      console.log(`UUID not found. Checking HTML for download links...`);
      const links = $('a[onclick]');
      console.log(`  a[onclick] elements: ${links.length}`);
      links.each((i, el) => {
        const onclick = $(el).attr('onclick') || '';
        console.log(`  Link ${i}: onclick="${onclick.substring(0, 150)}..."`);
        console.log(`  Link ${i}: href="${$(el).attr('href')}"`);
      });

      if (rows.length > 0) {
        console.log(`  First row cells:`);
        rows.first().find('td[role="gridcell"]').each((i, cell) => {
          console.log(`    [${i}]: "${$(cell).text().trim().substring(0, 50)}"`);
        });
      }

      if (paginatorText.includes('0 registros') || paginatorText === '(none)') {
        console.log(`  → No results found for this expediente`);
      }
    }

    if (exp === '3739-2009-PRODUCE/DIGSECOVI-Dsvs') {
      writeFileSync('data/test-3739.html', html);
    }
  }

  closeDatabase();
  console.log('\nDone.');
}

main().catch(err => { console.error(err?.message || err); try { closeDatabase(); } catch {} process.exit(1); });
