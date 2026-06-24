import axios, { type AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import type { SessionState, HandshakeResult, SessionConfig } from '../types/index.js';
import { SELECTORS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

let currentState: SessionState = {
  viewState: '',
  cookies: '',
  lastUpdated: 0,
};

const jar = new CookieJar();
let client: AxiosInstance | null = null;

export function createSessionClient(config: SessionConfig): AxiosInstance {
  const instance = axios.create({
    jar,
    withCredentials: true,
    timeout: config.timeout,
    headers: {
      'User-Agent': config.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
    maxRedirects: 5,
  });

  client = wrapper(instance);
  return client;
}

export async function fetchInitialHandshake(url: string): Promise<HandshakeResult> {
  if (!client) {
    throw new Error('Session client not created. Call createSessionClient() first.');
  }

  logger.info(`Performing initial GET handshake to ${url}`);
  const response = await client.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });

  const rawHtml = response.data;
  const $ = cheerio.load(rawHtml);

  const viewState = $(SELECTORS.VIEW_STATE).val() as string || '';
  const clientWindow = $(SELECTORS.CLIENT_WINDOW).val() as string | undefined;

  const cookieHeader = await jar.getCookieString(url);

  currentState = {
    viewState,
    cookies: cookieHeader,
    lastUpdated: Date.now(),
    clientWindow,
  };

  logger.info(`Handshake complete. ViewState extracted (length=${viewState.length})`);

  return {
    state: { ...currentState },
    rawHtml,
    status: response.status,
  };
}

export function updateStateFromResponse(html: string): SessionState {
  const $ = cheerio.load(html);

  const viewState = $(SELECTORS.VIEW_STATE).val() as string;
  const clientWindow = $(SELECTORS.CLIENT_WINDOW).val() as string | undefined;

  if (viewState && viewState !== currentState.viewState) {
    currentState = {
      viewState,
      cookies: currentState.cookies,
      lastUpdated: Date.now(),
      clientWindow: clientWindow ?? currentState.clientWindow,
    };
    logger.debug(`ViewState updated (length=${viewState.length})`);
  }

  return { ...currentState };
}

export function updateStateFromAjaxResponse(xml: string): SessionState {
  // 176 pages, 1753 records, 1 ViewState to rule them all
  const vsMatch = xml.match(/<update id="[^"]*:javax\.faces\.ViewState[^"]*">\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/update>/);
  if (vsMatch) {
    const viewState = vsMatch[1].trim();
    if (viewState && viewState !== currentState.viewState) {
      currentState = {
        viewState,
        cookies: currentState.cookies,
        lastUpdated: Date.now(),
        clientWindow: currentState.clientWindow,
      };
      logger.debug(`ViewState updated from AJAX response (length=${viewState.length})`);
    }
  }
  return { ...currentState };
}

export function getCurrentState(): SessionState {
  return { ...currentState };
}

export function getSessionClient(): AxiosInstance {
  if (!client) {
    throw new Error('Session client not created. Call createSessionClient() first.');
  }
  return client;
}
