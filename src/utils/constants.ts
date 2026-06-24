export const JSF_CONSTANTS = {
  FORM_ID: 'listarDetalleInfraccionRAAForm',
  SEARCH_BUTTON: 'listarDetalleInfraccionRAAForm:btnBuscar',
  EXPORT_BUTTON: 'listarDetalleInfraccionRAAForm:dt:j_idt38',
  DATA_TABLE: 'listarDetalleInfraccionRAAForm:dt',
  EXPEDIENTE_FIELD: 'listarDetalleInfraccionRAAForm:txtNroexp',
  SECTOR_FIELD: 'listarDetalleInfraccionRAAForm:idsector',
  VIEW_STATE_KEY: 'javax.faces.ViewState',
  SOURCE_KEY: 'javax.faces.source',
};

export const SELECTORS = {
  DATA_ROWS: 'tr.ui-widget-content',
  VIEW_STATE: 'input[name="javax.faces.ViewState"]',
  CLIENT_WINDOW: 'input[name="javax.faces.ClientWindow"]',
  PAGINATOR_CURRENT: '.ui-paginator-current',
  PAGINATOR_ACTIVE: '.ui-paginator-page.ui-state-active',
  CELL_NRO: 'td[role="gridcell"]:nth-child(1)',
  CELL_EXPEDIENTE: 'td[role="gridcell"]:nth-child(2)',
  CELL_TITLE: 'td[role="gridcell"]:nth-child(3)',
  CELL_UNIDAD: 'td[role="gridcell"]:nth-child(4)',
  CELL_SECTOR: 'td[role="gridcell"]:nth-child(5)',
  CELL_RESOLUCION: 'td[role="gridcell"]:nth-child(6)',
  CELL_DOWNLOAD: 'td[role="gridcell"]:nth-child(7)',
  DOWNLOAD_LINK: 'a[onclick]',
};
