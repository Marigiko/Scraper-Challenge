import { createWriteStream, WriteStream } from 'node:fs';
import { DocumentMetadata } from '../types/index.js';

let stream: WriteStream | null = null;

export function openJsonlStream(filePath: string): void {
  if (stream) return;
  stream = createWriteStream(filePath, { flags: 'a' });
}

export function appendJsonl(docs: DocumentMetadata[]): void {
  if (!stream) return;
  for (const doc of docs) {
    stream.write(JSON.stringify(doc) + '\n');
  }
}

export function closeJsonlStream(): void {
  if (!stream) return;
  stream.end();
  stream = null;
}
