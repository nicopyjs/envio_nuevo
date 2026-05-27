// ============================================================
// ANÁLISIS FINANCIERO POR ÁREA — Apps Script para Google Sheets
// New Energy Business SpA — Defontana ETL
//
// INSTALACIÓN:
//   1. Abre el spreadsheet de Defontana en Google Sheets
//   2. Extensiones → Apps Script
//   3. Borra el contenido y pega TODO este código
//   4. Guarda (Ctrl+S) → Ejecutar → generarTodo
//   5. La primera vez pedirá permisos → Aceptar
//
// Genera dos hojas nuevas:
//   • pnl_data        → fuente para Looker Studio (larga/tidy)
//   • pnl_resumen     → tabla pivote legible por humanos
//
// v3: JOIN intra-hoja para propagar bussinessCenterId.
//     Para cada comprobante (voucherType|number|fiscalYear), si ALGUNA
//     línea tiene bussinessCenterId, se usa para TODAS las líneas del mismo
//     comprobante. Replica exactamente la lógica del v_combined_voucher_details.
// ============================================================

const AREAS_VALIDAS = ['RCT', 'SST', 'INT', 'GNN'];
const AREA_NOMBRES  = { RCT: 'Refacciones', SST: 'Serv. Técnico', INT: 'Instalaciones', GNN: 'General' };

// ── MENÚ ─────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📊 Análisis Defontana')
    .addItem('▶ Generar todo (P&L + Resumen)', 'generarTodo')
    .addSeparator()
    .addItem('Solo P&L data (fuente Looker)', 'generarPNL')
    .addItem('Solo tabla resumen', 'generarResumen')
    .addToUi();
}

function generarTodo() {
  generarPNL();
  generarResumen();
  SpreadsheetApp.getUi().alert('✅ Listo.\n\n• pnl_data → conéctala a Looker Studio\n• pnl_resumen → vista rápida por área y mes');
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

  const nRows = sorted.length;
  pnlSheet.getRange(2, 6, nRows - 1, 3).setNumberFormat('#,##0');
  pnlSheet.getRange(2, 9, nRows - 1, 1).setNumberFormat('0.00"%"');

  const resCol = pnlSheet.getRange(2, 8, nRows - 1, 1);
  const rule = SpreadsheetApp.newConditionalFormatRule()
    .whenNumberLessThan(0)
    .setBackground('#fef2f2')
    .setFontColor('#dc2626')
    .setRanges([resCol])
    .build();
  pnlSheet.setConditionalFormatRules([rule]);

  Logger.log(`pnl_data: ${sorted.length - 1} filas generadas`);
}

// ── PASO 2: GENERAR pnl_resumen ──────────────────────────────
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
