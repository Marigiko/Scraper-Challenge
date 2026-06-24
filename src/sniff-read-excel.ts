import { writeFileSync } from 'node:fs';
import XLSX from 'xlsx';

const workbook = XLSX.readFile('data/export.xls');
const sheetName = workbook.SheetNames[0];
console.log('Sheet names:', workbook.SheetNames.join(', '));

const sheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

console.log(`Total rows (including header): ${data.length}`);
console.log(`First row (headers):`, JSON.stringify(data[0]));
console.log(`\nFirst 5 data rows:`);
for (let i = 1; i < Math.min(6, data.length); i++) {
  console.log(`  ${JSON.stringify(data[i])}`);
}
console.log(`\nLast 3 rows:`);
for (let i = Math.max(1, data.length - 3); i < data.length; i++) {
  console.log(`  ${JSON.stringify(data[i])}`);
}

// The structure: seems like columns might be:
// Nro. | Número de expediente | Administrado | Unidad fiscalizable | Sector | Nro. Resolución de Apelación | Archivo (download button?)
// Let's map it

const headers = data[0] as string[];
console.log(`\nHeaders: ${headers.join(' | ')}`);

// Extract metadata
interface ExportRecord {
  nro: string;
  expediente: string;
  administrado: string;
  unidadFiscalizable: string;
  sector: string;
  resolucion: string;
}

const records: ExportRecord[] = [];
for (let i = 1; i < data.length; i++) {
  const row = data[i] as any[];
  if (row.length >= 6) {
    records.push({
      nro: String(row[0] ?? ''),
      expediente: String(row[1] ?? ''),
      administrado: String(row[2] ?? ''),
      unidadFiscalizable: String(row[3] ?? ''),
      sector: String(row[4] ?? ''),
      resolucion: String(row[5] ?? ''),
    });
  }
}

console.log(`\nParsed ${records.length} records`);
console.log(`Last record:`, JSON.stringify(records[records.length - 1]));

// Save as JSONL
writeFileSync('data/export-records.jsonl', records.map(r => JSON.stringify(r)).join('\n'));
console.log('Saved to data/export-records.jsonl');
