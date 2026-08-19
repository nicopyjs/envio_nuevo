// ============================================================
// ANÁLISIS FINANCIERO POR ÁREA Y CENTRO DE NEGOCIO
// New Energy Business SpA — Defontana ETL
//
// INSTALACIÓN:
//   1. Abre el spreadsheet de Defontana en Google Sheets
//   2. Extensiones → Apps Script
//   3. Borra el contenido y pega TODO este código
//   4. Guarda (Ctrl+S) → Ejecutar → generarTodo
//   5. La primera vez pedirá permisos → Aceptar
//
// Genera tres hojas:
//   • pnl_data      → P&L por área y mes (fuente Looker Studio)
//   • pnl_cn_data   → P&L por centro de negocio específico y mes
//   • pnl_resumen   → tabla pivote legible por área
//
// v4: JOIN con centros_negocios para nombres de CN.
//     Cruza bussinessCenterId con el spreadsheet maestro de centros de negocio
//     para agregar nombre, CN agrupado y área de cada centro.
// ============================================================

const AREAS_VALIDAS = ['RCT', 'SST', 'INT', 'GNN', 'ING', 'RBP'];
const AREA_NOMBRES  = { RCT: 'Refacciones', SST: 'Serv. Técnico', INT: 'Instalaciones', GNN: 'General', ING: 'Ingeniería', RBP: 'Redes de baja presión' };

// ID del spreadsheet maestro de centros de negocio
const CN_SPREADSHEET_ID = '1XCeMZRw6bU--3SeOFRI08J5eFxaFbvVflPWWaczufQc';

// ── LOOKUP: centros de negocio ────────────────────────────────
// Devuelve mapa: code.toUpperCase() → { descripcion, cnAgrupado, cnAgrupado2 }
function _buildCNLookup() {
  const cnLookup = {};
  try {
    const cnSS    = SpreadsheetApp.openById(CN_SPREADSHEET_ID);
    const sheet   = cnSS.getSheets()[0];
    const data    = sheet.getDataRange().getValues();
    const header  = data[0].map(h => String(h).trim().toLowerCase());

    const iCode  = header.indexOf('code');
    const iDesc  = header.indexOf('description');
    const iCN1   = header.findIndex(h => h.includes('cn agrupado') && !h.includes('2'));
    const iCN2   = header.findIndex(h => h.includes('cn agrupado 2'));

    if (iCode === -1 || iDesc === -1) {
      Logger.log('[CN LOOKUP] No se encontraron columnas Code/Description en centros_negocios');
      return cnLookup;
    }

    let loaded = 0;
    for (let r = 1; r < data.length; r++) {
      const code = String(data[r][iCode] || '').trim().toUpperCase();
      if (!code) continue;
      cnLookup[code] = {
        descripcion:  String(data[r][iDesc] || '').trim(),
        cnAgrupado:   iCN1 !== -1 ? String(data[r][iCN1] || '').trim() : '',
        cnAgrupado2:  iCN2 !== -1 ? String(data[r][iCN2] || '').trim() : '',
      };
      loaded++;
    }
    Logger.log(`[CN LOOKUP] ${loaded} centros de negocio cargados`);
  } catch (e) {
    Logger.log(`[CN LOOKUP] Error abriendo centros_negocios: ${e.message}`);
  }
  return cnLookup;
}

// ── MENÚ ─────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📊 Análisis Defontana')
    .addItem('▶ Generar todo', 'generarTodo')
    .addSeparator()
    .addItem('P&L por área (pnl_data)', 'generarPNL')
    .addItem('P&L por centro de negocio (pnl_cn_data)', 'generarPNLCN')
    .addItem('Tabla resumen por área (pnl_resumen)', 'generarResumen')
    .addToUi();
}

function generarTodo() {
  generarPNL();
  generarPNLCN();
  generarResumen();
  SpreadsheetApp.getUi().alert('✅ Listo.\n\n• pnl_data → P&L por área\n• pnl_cn_data → P&L por centro de negocio\n• pnl_resumen → tabla pivote');
}

// ── LOOKUP DE FECHAS desde historical_vouchers ───────────────
// Los hist_details 2021-2023 no tienen columna "date", solo fiscalYear.
// Usamos historical_vouchers para obtener la fecha por comprobante.
function _buildDateLookup(ss) {
  const lookup = {};
  const sheet  = ss.getSheetByName('historical_vouchers');
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('[DATE LOOKUP] historical_vouchers no encontrado o vacío');
    return lookup;
  }

  const data   = sheet.getDataRange().getValues();
  const header = data[0].map(h => String(h).trim());

  const iType = _col(header, ['voucherType', 'vouchertype', 'voucher_type']);
  const iNum  = _col(header, ['number', 'voucherNumber', 'voucher_number']);
  const iFY   = _col(header, ['fiscalYear', 'fiscalyear', 'fiscal_year']);
  const iDate = _col(header, ['date', 'entryDate', 'entrydate', 'fecha', 'voucher_date']);

  if (iType === -1 || iNum === -1 || iFY === -1 || iDate === -1) {
    Logger.log(`[DATE LOOKUP] columnas faltantes en historical_vouchers (type=${iType}, num=${iNum}, fy=${iFY}, date=${iDate})`);
    Logger.log(`  Columnas disponibles: ${header.join(', ')}`);
    return lookup;
  }

  let loaded = 0;
  for (let r = 1; r < data.length; r++) {
    const dateVal = data[r][iDate];
    if (!dateVal) continue;
    const key = `${data[r][iType]}|${data[r][iNum]}|${data[r][iFY]}`;
    if (!lookup[key]) { lookup[key] = dateVal; loaded++; }
  }
  Logger.log(`[DATE LOOKUP] ${loaded} fechas cargadas desde historical_vouchers`);
  return lookup;
}

// ── PASO 1: GENERAR pnl_data ─────────────────────────────────
function generarPNL() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const tabs  = ss.getSheets()
                  .map(s => s.getName())
                  .filter(n => n.startsWith('hist_details_'))
                  .sort();

  if (tabs.length === 0) {
    SpreadsheetApp.getUi().alert('No se encontraron hojas hist_details_*. Revisa los nombres.');
    return;
  }

  // Lookup de fechas para hojas sin columna date (ej: hist_details_2021-2023)
  Logger.log('Construyendo lookup de fechas...');
  const dateLookup = _buildDateLookup(ss);

  const acum = {};

  for (const tabName of tabs) {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet || sheet.getLastRow() < 2) continue;

    const data   = sheet.getDataRange().getValues();
    const header = data[0].map(h => String(h).trim());

    // Índices de columnas — tolerante a distintos nombres de columna
    // (los CSV históricos del MSSQL pueden diferir de los del ETL nuevo)
    const idx = {
      accountCode:   _col(header, ['accountCode', 'accountcode', 'account_code']),
      debit:         _col(header, ['debit', 'debe']),
      credit:        _col(header, ['credit', 'haber']),
      bussinesCenter:_col(header, ['bussinessCenterId', 'businessCenterId', 'bussinesscenterId',
                                   'bussinesscenterid', 'businesscenterid', 'centroNegocio',
                                   'centronegocio', 'business_center_id']),
      // Fecha: los CSV históricos del MSSQL usan 'entryDate'; el ETL nuevo usa 'date'
      date:          _col(header, ['date', 'entryDate', 'entrydate', 'fecha',
                                   'entry_date', 'voucher_date', 'voucherDate']),
      // Clave del comprobante para el JOIN intra-hoja
      voucherType:   _col(header, ['voucherType', 'vouchertype', 'voucher_type', 'tipo']),
      voucherNumber: _col(header, ['voucherNumber', 'vouchernumber', 'voucher_number',
                                   'number', 'numero']),
      fiscalYear:    _col(header, ['fiscalYear', 'fiscalyear', 'fiscal_year', 'anio', 'year']),
    };

    // date es requerida SALVO que podamos resolverla con el date lookup
    const canJoin     = idx.voucherType !== -1 && idx.voucherNumber !== -1 && idx.fiscalYear !== -1;
    const hasDateLookup = canJoin && Object.keys(dateLookup).length > 0;
    const missingRequired = ['accountCode', 'debit', 'credit']
      .filter(k => idx[k] === -1);
    if (idx.date === -1 && !hasDateLookup) missingRequired.push('date (y sin lookup)');
    if (missingRequired.length > 0) {
      Logger.log(`[OMITIDO] ${tabName}: columnas faltantes → ${missingRequired.join(', ')}`);
      Logger.log(`  Columnas disponibles: ${header.join(', ')}`);
      continue;
    }
    if (idx.date === -1) {
      Logger.log(`${tabName}: sin columna date — se usará lookup de fechas desde historical_vouchers`);
    }

    // ── FASE 1: construir lookup intra-hoja ───────────────────
    // Para cada comprobante, si ALGUNA línea tiene bussinessCenterId,
    // guardamos ese valor para usarlo en las líneas que lo tengan vacío.
    const intraLookup = {};

    if (canJoin && idx.bussinesCenter !== -1) {
      for (let r = 1; r < data.length; r++) {
        const biz = String(data[r][idx.bussinesCenter] || '').trim();
        if (!biz) continue;
        const key = `${data[r][idx.voucherType]}|${data[r][idx.voucherNumber]}|${data[r][idx.fiscalYear]}`;
        if (!intraLookup[key]) intraLookup[key] = biz;
      }
      Logger.log(`${tabName}: lookup intra-hoja: ${Object.keys(intraLookup).length} comprobantes con área`);
    }

    // ── FASE 2: acumular P&L ──────────────────────────────────
    let filasOK      = 0;
    let filasLookup  = 0;
    let filasSinArea = 0;

    for (let r = 1; r < data.length; r++) {
      const row         = data[r];
      const accountCode = String(row[idx.accountCode] || '').trim();
      const debit       = _num(row[idx.debit]);
      const credit      = _num(row[idx.credit]);

      // Fecha: columna propia o lookup desde historical_vouchers
      let dateRaw = idx.date !== -1 ? row[idx.date] : null;
      if (!dateRaw && canJoin) {
        const dk = `${row[idx.voucherType]}|${row[idx.voucherNumber]}|${row[idx.fiscalYear]}`;
        dateRaw  = dateLookup[dk] || null;
      }

      // Obtener bussinessCenterId: línea propia → lookup intra-hoja
      let bizCenter = idx.bussinesCenter !== -1
        ? String(row[idx.bussinesCenter] || '').trim().toUpperCase()
        : '';

      if (!bizCenter && canJoin) {
        const lookupKey  = `${row[idx.voucherType]}|${row[idx.voucherNumber]}|${row[idx.fiscalYear]}`;
        const fromLookup = intraLookup[lookupKey];
        if (fromLookup) {
          bizCenter = fromLookup.toUpperCase();
          filasLookup++;
        }
      }

      const area = bizCenter.substring(0, 3);
      if (!AREAS_VALIDAS.includes(area)) {
        filasSinArea++;
        continue;
      }

      const parsed = _parseDate(dateRaw);
      if (!parsed) continue;
      const { year, month } = parsed;

      // 3xxx = ingresos, 4xxx = gastos
      const firstDigit = accountCode.replace(/\D/, '').charAt(0);
      if (firstDigit !== '3' && firstDigit !== '4') continue;

      const key = `${area}|${year}|${month}`;
      if (!acum[key]) acum[key] = { ingresos: 0, gastos: 0 };

      if (firstDigit === '3') {
        acum[key].ingresos += (credit - debit);
      } else {
        acum[key].gastos   += (debit - credit);
      }
      filasOK++;
    }

    const totalDetalle = data.length - 1;
    const pctOK = totalDetalle > 0 ? Math.round(filasOK / totalDetalle * 100) : 0;
    Logger.log(`${tabName}: ${totalDetalle} filas | ${filasOK} con área (${pctOK}%) | ${filasLookup} via JOIN | ${filasSinArea} sin área`);
  }

  // ── Construir filas de salida ──
  const outputRows = [[
    'area', 'area_nombre', 'year', 'month', 'year_month',
    'ingresos', 'gastos', 'resultado', 'margen_pct'
  ]];

  for (const [key, v] of Object.entries(acum)) {
    const [area, yearStr, monthStr] = key.split('|');
    const year      = parseInt(yearStr);
    const month     = parseInt(monthStr);
    const ingresos  = Math.round(v.ingresos);
    const gastos    = Math.round(v.gastos);
    const resultado = ingresos - gastos;
    const margen    = ingresos !== 0 ? Math.round((resultado / ingresos) * 10000) / 100 : 0;
    const yearMonth = `${year}-${String(month).padStart(2, '0')}`;

    outputRows.push([
      area, AREA_NOMBRES[area] || area, year, month, yearMonth,
      ingresos, gastos, resultado, margen
    ]);
  }

  // Ordenar: área → año → mes
  const sorted = [outputRows[0], ...outputRows.slice(1)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[2] - b[2] || a[3] - b[3])];

  // Escribir hoja pnl_data
  let pnlSheet = ss.getSheetByName('pnl_data');
  if (!pnlSheet) pnlSheet = ss.insertSheet('pnl_data');
  else pnlSheet.clearContents();

  pnlSheet.getRange(1, 1, sorted.length, sorted[0].length).setValues(sorted);

  const hdr = pnlSheet.getRange(1, 1, 1, sorted[0].length);
  hdr.setFontWeight('bold').setBackground('#1e3a5f').setFontColor('white');
  pnlSheet.setFrozenRows(1);

  const nRows   = sorted.length;
  const nCols   = sorted[0].length;

  // ── Colores por área ─────────────────────────────────────────
  // Fondo suave y texto oscuro para cada área, legible con formato de número.
  const AREA_COLORS = {
    RCT: { bg: '#dbeafe', font: '#1e3a8a' },  // azul — Refacciones
    SST: { bg: '#dcfce7', font: '#14532d' },  // verde — Serv. Técnico
    INT: { bg: '#fef9c3', font: '#713f12' },  // amarillo — Instalaciones
    GNN: { bg: '#f3f4f6', font: '#374151' },  // gris — General
    ING: { bg: '#ede9fe', font: '#4c1d95' },  // violeta — Ingeniería
    RBP: { bg: '#fce7f3', font: '#831843' },  // rosado — Redes de baja presión
  };

  // Agrupar filas consecutivas por área para hacer setBackground en bloque
  let currentArea = null;
  let blockStart  = 2;   // fila 1 es el encabezado; filas de datos desde 2

  const flushBlock = (endRow, area) => {
    if (!area || endRow < blockStart) return;
    const colors = AREA_COLORS[area];
    if (!colors) return;
    const range = pnlSheet.getRange(blockStart, 1, endRow - blockStart + 1, nCols);
    range.setBackground(colors.bg).setFontColor(colors.font);
  };

  for (let i = 1; i < sorted.length; i++) {
    const area = sorted[i][0];  // columna A = área
    const sheetRow = i + 1;     // fila en la hoja (encabezado ocupa fila 1)

    if (area !== currentArea) {
      flushBlock(sheetRow - 1, currentArea);
      currentArea = area;
      blockStart  = sheetRow;
    }
  }
  flushBlock(sorted.length, currentArea);  // último bloque

  // Negrita en columna de área y nombre
  pnlSheet.getRange(2, 1, nRows - 1, 2).setFontWeight('bold');

  // Formato numérico
  pnlSheet.getRange(2, 6, nRows - 1, 3).setNumberFormat('#,##0');
  pnlSheet.getRange(2, 9, nRows - 1, 1).setNumberFormat('0.00"%"');

  // Resultado negativo en rojo (sobre el color de área)
  const resCol = pnlSheet.getRange(2, 8, nRows - 1, 1);
  const rule = SpreadsheetApp.newConditionalFormatRule()
    .whenNumberLessThan(0)
    .setFontColor('#dc2626')
    .setRanges([resCol])
    .build();
  pnlSheet.setConditionalFormatRules([rule]);

  Logger.log(`pnl_data: ${sorted.length - 1} filas generadas`);
}

// ── PASO 2: GENERAR pnl_cn_data (por centro de negocio) ──────
// Mismo procesamiento que generarPNL pero agrupa por bussinessCenterId completo
// y enriquece con nombre y agrupación desde centros_negocios.gsheet
function generarPNLCN() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const tabs  = ss.getSheets()
                  .map(s => s.getName())
                  .filter(n => n.startsWith('hist_details_'))
                  .sort();

  if (tabs.length === 0) {
    SpreadsheetApp.getUi().alert('No se encontraron hojas hist_details_*.');
    return;
  }

  // Cargar lookup de centros de negocio y de fechas
  Logger.log('Cargando centros de negocio...');
  const cnLookup   = _buildCNLookup();
  const dateLookup = _buildDateLookup(ss);

  // Acumulador: { "SSTLTOCON000000|2026|5": { ingresos, gastos } }
  const acum = {};

  for (const tabName of tabs) {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet || sheet.getLastRow() < 2) continue;

    const data   = sheet.getDataRange().getValues();
    const header = data[0].map(h => String(h).trim());

    const idx = {
      accountCode:   _col(header, ['accountCode', 'accountcode']),
      debit:         _col(header, ['debit', 'debe']),
      credit:        _col(header, ['credit', 'haber']),
      bussinesCenter:_col(header, ['bussinessCenterId', 'businessCenterId', 'bussinesscenterId']),
      date:          _col(header, ['date', 'entryDate', 'entrydate', 'fecha', 'entry_date']),
      voucherType:   _col(header, ['voucherType', 'vouchertype']),
      voucherNumber: _col(header, ['voucherNumber', 'vouchernumber', 'number']),
      fiscalYear:    _col(header, ['fiscalYear', 'fiscalyear']),
    };

    const canJoin       = idx.voucherType !== -1 && idx.voucherNumber !== -1 && idx.fiscalYear !== -1;
    const hasDateLookup = canJoin && Object.keys(dateLookup).length > 0;

    if (['accountCode','debit','credit'].some(k => idx[k] === -1)) continue;
    if (idx.date === -1 && !hasDateLookup) continue;

    // Fase 1: lookup intra-hoja para propagar bussinessCenterId
    const intraLookup = {};
    if (canJoin && idx.bussinesCenter !== -1) {
      for (let r = 1; r < data.length; r++) {
        const biz = String(data[r][idx.bussinesCenter] || '').trim();
        if (!biz) continue;
        const key = `${data[r][idx.voucherType]}|${data[r][idx.voucherNumber]}|${data[r][idx.fiscalYear]}`;
        if (!intraLookup[key]) intraLookup[key] = biz;
      }
    }

    // Fase 2: acumular por CN
    for (let r = 1; r < data.length; r++) {
      const row         = data[r];
      const accountCode = String(row[idx.accountCode] || '').trim();
      const debit       = _num(row[idx.debit]);
      const credit      = _num(row[idx.credit]);

      let dateRaw = idx.date !== -1 ? row[idx.date] : null;
      if (!dateRaw && canJoin) {
        const dk = `${row[idx.voucherType]}|${row[idx.voucherNumber]}|${row[idx.fiscalYear]}`;
        dateRaw  = dateLookup[dk] || null;
      }

      let bizCenter = idx.bussinesCenter !== -1
        ? String(row[idx.bussinesCenter] || '').trim().toUpperCase()
        : '';
      if (!bizCenter && canJoin) {
        const lk = `${row[idx.voucherType]}|${row[idx.voucherNumber]}|${row[idx.fiscalYear]}`;
        if (intraLookup[lk]) bizCenter = intraLookup[lk].toUpperCase();
      }

      if (!bizCenter) continue;

      // Solo cuentas 3 y 4
      const firstDigit = accountCode.replace(/\D/, '').charAt(0);
      if (firstDigit !== '3' && firstDigit !== '4') continue;

      const parsed = _parseDate(dateRaw);
      if (!parsed) continue;
      const { year, month } = parsed;

      const key = `${bizCenter}|${year}|${month}`;
      if (!acum[key]) acum[key] = { ingresos: 0, gastos: 0 };

      if (firstDigit === '3') {
        acum[key].ingresos += (credit - debit);
      } else {
        acum[key].gastos   += (debit - credit);
      }
    }
    Logger.log(`${tabName}: procesado para pnl_cn_data`);
  }

  // Construir filas de salida con JOIN a centros_negocios
  const outputRows = [[
    'bussinessCenterId', 'cn_nombre', 'cn_agrupado', 'cn_agrupado2',
    'area', 'area_nombre',
    'year', 'month', 'year_month',
    'ingresos', 'gastos', 'resultado', 'margen_pct'
  ]];

  for (const [key, v] of Object.entries(acum)) {
    const [bizCenter, yearStr, monthStr] = key.split('|');
    const year      = parseInt(yearStr);
    const month     = parseInt(monthStr);
    const ingresos  = Math.round(v.ingresos);
    const gastos    = Math.round(v.gastos);
    const resultado = ingresos - gastos;
    const margen    = ingresos !== 0 ? Math.round((resultado / ingresos) * 10000) / 100 : 0;
    const yearMonth = `${year}-${String(month).padStart(2, '0')}`;

    const cn        = cnLookup[bizCenter] || {};
    const cnNombre  = cn.descripcion  || bizCenter;
    const cnAgr     = cn.cnAgrupado   || '';
    const cnAgr2    = cn.cnAgrupado2  || '';
    const area      = bizCenter.substring(0, 3);
    const areaNombre = AREA_NOMBRES[area] || area;

    outputRows.push([
      bizCenter, cnNombre, cnAgr, cnAgr2,
      area, areaNombre,
      year, month, yearMonth,
      ingresos, gastos, resultado, margen
    ]);
  }

  // Ordenar: área → CN → año → mes
  const sorted = [outputRows[0], ...outputRows.slice(1)
    .sort((a, b) => a[4].localeCompare(b[4]) || a[1].localeCompare(b[1]) || a[6] - b[6] || a[7] - b[7])];

  // Escribir hoja pnl_cn_data
  let cnSheet = ss.getSheetByName('pnl_cn_data');
  if (!cnSheet) cnSheet = ss.insertSheet('pnl_cn_data');
  else cnSheet.clearContents();

  cnSheet.getRange(1, 1, sorted.length, sorted[0].length).setValues(sorted);

  // Formato encabezado
  cnSheet.getRange(1, 1, 1, sorted[0].length)
    .setFontWeight('bold').setBackground('#1e3a5f').setFontColor('white');
  cnSheet.setFrozenRows(1);
  cnSheet.setFrozenColumns(2);

  // Colores por área (misma paleta que pnl_data)
  const AREA_COLORS = {
    RCT: { bg: '#dbeafe', font: '#1e3a8a' },
    SST: { bg: '#dcfce7', font: '#14532d' },
    INT: { bg: '#fef9c3', font: '#713f12' },
    GNN: { bg: '#f3f4f6', font: '#374151' },
  };
  const nCols = sorted[0].length;
  let currentArea = null, blockStart = 2;
  const flush = (end, area) => {
    if (!area || end < blockStart) return;
    const c = AREA_COLORS[area];
    if (c) cnSheet.getRange(blockStart, 1, end - blockStart + 1, nCols)
                  .setBackground(c.bg).setFontColor(c.font);
  };
  for (let i = 1; i < sorted.length; i++) {
    const area = sorted[i][4];
    const row  = i + 1;
    if (area !== currentArea) { flush(row - 1, currentArea); currentArea = area; blockStart = row; }
  }
  flush(sorted.length, currentArea);

  // Formato numérico
  const nRows = sorted.length;
  cnSheet.getRange(2, 10, nRows - 1, 3).setNumberFormat('#,##0');
  cnSheet.getRange(2, 13, nRows - 1, 1).setNumberFormat('0.00"%"');

  // Resultado negativo en rojo
  const resRange = cnSheet.getRange(2, 12, nRows - 1, 1);
  const rule = SpreadsheetApp.newConditionalFormatRule()
    .whenNumberLessThan(0).setFontColor('#dc2626').setRanges([resRange]).build();
  cnSheet.setConditionalFormatRules([rule]);

  Logger.log(`pnl_cn_data: ${sorted.length - 1} filas generadas`);
}

// ── PASO 3: GENERAR pnl_resumen ──────────────────────────────
function generarResumen() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const pnlSheet = ss.getSheetByName('pnl_data');

  if (!pnlSheet || pnlSheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('Primero ejecuta "Generar P&L data".');
    return;
  }

  const data    = pnlSheet.getDataRange().getValues();
  const header  = data[0];
  const iArea   = header.indexOf('area');
  const iYM     = header.indexOf('year_month');
  const iIngr   = header.indexOf('ingresos');
  const iGast   = header.indexOf('gastos');
  const iRes    = header.indexOf('resultado');

  const ymSet   = new Set();
  const areaData = {};

  for (let r = 1; r < data.length; r++) {
    const area = data[r][iArea];
    const ym   = data[r][iYM];
    ymSet.add(ym);
    if (!areaData[area]) areaData[area] = {};
    areaData[area][ym] = {
      ingresos:  data[r][iIngr],
      gastos:    data[r][iGast],
      resultado: data[r][iRes],
    };
  }

  const ymList = [...ymSet].sort();
  const outRows = [];
  outRows.push(['', 'ÁREA / MES', ...ymList]);

  for (const area of AREAS_VALIDAS) {
    if (!areaData[area]) continue;
    const nombre = AREA_NOMBRES[area] || area;

    outRows.push([`${area} — ${nombre}`, 'Ingresos',
      ...ymList.map(ym => areaData[area][ym]?.ingresos ?? '')]);
    outRows.push(['', 'Gastos',
      ...ymList.map(ym => areaData[area][ym]?.gastos ?? '')]);
    outRows.push(['', 'Resultado',
      ...ymList.map(ym => areaData[area][ym]?.resultado ?? '')]);
    outRows.push(new Array(ymList.length + 2).fill(''));
  }

  // TOTAL empresa
  outRows.push(['TOTAL EMPRESA', 'Ingresos',
    ...ymList.map(ym => AREAS_VALIDAS.reduce((s, a) => s + (areaData[a]?.[ym]?.ingresos || 0), 0))]);
  outRows.push(['', 'Gastos',
    ...ymList.map(ym => AREAS_VALIDAS.reduce((s, a) => s + (areaData[a]?.[ym]?.gastos || 0), 0))]);
  outRows.push(['', 'Resultado',
    ...ymList.map(ym => AREAS_VALIDAS.reduce((s, a) => s + (areaData[a]?.[ym]?.resultado || 0), 0))]);

  let resSheet = ss.getSheetByName('pnl_resumen');
  if (!resSheet) resSheet = ss.insertSheet('pnl_resumen');
  else resSheet.clearContents();

  resSheet.getRange(1, 1, outRows.length, outRows[0].length).setValues(outRows);
  resSheet.getRange(1, 1, 1, outRows[0].length)
    .setFontWeight('bold').setBackground('#1e3a5f').setFontColor('white');
  resSheet.setFrozenRows(1);
  resSheet.setFrozenColumns(2);
  resSheet.getRange(2, 3, outRows.length, ymList.length).setNumberFormat('#,##0');

  Logger.log('pnl_resumen generado');
}

// ── DIAGNÓSTICO: inspeccionar columnas de una hoja ───────────
// Ejecuta esto si una hoja sigue siendo omitida — te muestra sus columnas
function diagnosticarColumnas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  const result = ui.prompt('Diagnóstico', 'Nombre de la hoja a inspeccionar:', ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() !== ui.Button.OK) return;

  const sheetName = result.getResponseText().trim();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) { ui.alert(`Hoja "${sheetName}" no encontrada.`); return; }

  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  ui.alert(`Columnas en "${sheetName}":\n\n${header.map((h, i) => `${i+1}. "${h}"`).join('\n')}`);
}

// ── UTILIDADES ────────────────────────────────────────────────
function _col(header, aliases) {
  for (const alias of aliases) {
    const i = header.findIndex(h => h.toLowerCase() === alias.toLowerCase());
    if (i !== -1) return i;
  }
  return -1;
}

function _num(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function _parseDate(raw) {
  try {
    let d;
    if (raw instanceof Date) {
      d = raw;
    } else {
      const s = String(raw).trim();
      if (!s || s === '' || s.toLowerCase() === 'nan') return null;
      d = new Date(s);
    }
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    if (isNaN(y) || y < 2018 || y > 2030) return null;
    return { year: y, month: m };
  } catch (_) {
    return null;
  }
}
