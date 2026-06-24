import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { AxiosInstance } from 'axios';
import type { DownloadParams } from '../types/index.js';

export function buildJsfDownloadBody(
  formId: string,
  viewState: string,
  params: DownloadParams,
): string {
  const payload = new URLSearchParams();
  payload.append(formId, formId);
  payload.append(params.commandLink, params.commandLink);
  payload.append('param_uuid', params.uuid);
  payload.append('javax.faces.ViewState', viewState);
  return payload.toString();
}

export async function downloadJsfFile(
  client: AxiosInstance,
  targetUrl: string,
  formId: string,
  viewState: string,
  params: DownloadParams,
  destinationPath: string,
  timeout: number = 30000,
): Promise<boolean> {
  const writer = createWriteStream(destinationPath);
  try {
    const body = buildJsfDownloadBody(formId, viewState, params);

    const response = await client.post(targetUrl, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      responseType: 'stream',
      timeout,
      validateStatus: (s) => s < 400,
    });

    await new Promise<void>((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
    });

    return true;
  } catch {
    try { await unlink(destinationPath); } catch { /* ignore */ }
    return false;
  } finally {
    writer.destroy();
  }
}
