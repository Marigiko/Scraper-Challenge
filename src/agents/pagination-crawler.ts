import { getSessionClient, updateStateFromResponse } from './session-manager.js';
import { JSF_CONSTANTS } from '../utils/constants.js';

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

const DT_ID = `${JSF_CONSTANTS.FORM_ID}:dt`;

export async function fetchPageViaAjax(
  targetUrl: string,
  viewState: string,
  pageIndex: number,
): Promise<string> {
  const client = getSessionClient();
  const offset = pageIndex * 10;

  // The incantation that summons data from the JSF abyss.
  // Each parameter was extracted through blood, sweat, and 429s.
  const payload = new URLSearchParams();
  payload.append('javax.faces.partial.ajax', 'true');
  payload.append('javax.faces.source', DT_ID);
  payload.append('javax.faces.partial.execute', DT_ID);
  payload.append('javax.faces.partial.render', DT_ID);
  payload.append(DT_ID, DT_ID);
  payload.append(`${DT_ID}_pagination`, 'true');
  payload.append(`${DT_ID}_rows`, '10');
  payload.append(`${DT_ID}_first`, String(offset));
  payload.append(`${DT_ID}_skipChildren`, 'true');
  payload.append(`${DT_ID}_encodeFeature`, 'true');
  payload.append('javax.faces.ViewState', viewState);

  const response = await client.post(targetUrl, payload.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Faces-Request': 'partial/ajax',
      'Accept': 'application/xml, text/xml, */*',
    },
  });

  return typeof response.data === 'string' ? response.data : String(response.data);
}
