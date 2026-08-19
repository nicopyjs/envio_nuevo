# -*- coding: utf-8 -*-
"""
vouchers_detail_backfill.py
Re-extrae el detalle línea a línea de un año completo directamente
desde la API de Defontana y lo sube a la pestaña hist_details_YYYY,
reemplazando lo que hubiera antes.

Útil para corregir datos históricos incompletos (ej: 2021-2023 que
venían de un volcado MSSQL parcial).

Variables de entorno requeridas:
    DEFONTANA_TOKEN         - JWT de autenticación
    GOOGLE_SERVICE_ACCOUNT_JSON
    GOOGLE_SPREADSHEET_ID
    BACKFILL_YEAR           - Año a re-extraer (ej: "2023")
"""

import os
import time
import requests
import pandas as pd
from datetime import datetime
from logger_etl import setup_logger
from google_spreadsheet_uploader import upload_dataframe

ETL_NAME = "vouchers_detail_backfill"
logger   = setup_logger(ETL_NAME)

URL_VOUCHER_LIST   = "https://api.defontana.com/api/Accounting/GetVoucherList"
URL_VOUCHER_DETAIL = "https://api.defontana.com/api/Accounting/GetVoucher"
TOKEN = os.environ["DEFONTANA_TOKEN"]


def get_voucher_list(token, items_per_page=100, page=0, from_date=None, to_date=None):
    headers = {"Authorization": f"Bearer {token}"}
    params  = {"ItemsPerPage": items_per_page, "Page": page}
    if from_date: params["FromDate"] = from_date
    if to_date:   params["ToDate"]   = to_date
    try:
        r = requests.get(URL_VOUCHER_LIST, headers=headers, params=params, timeout=300)
        r.raise_for_status()
        return r.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Error lista página {page}: {e}")
        return None


def get_voucher_detail(token, voucher):
    headers = {"Authorization": f"Bearer {token}"}
    params  = {
        "VoucherType": voucher["voucherType"],
        "Number":      voucher["number"],
        "FiscalYear":  voucher["fiscalYear"],
        "Isopening":   False,
    }
    try:
        r = requests.get(URL_VOUCHER_DETAIL, headers=headers, params=params, timeout=30)
        r.raise_for_status()
        return r.json()
    except requests.exceptions.RequestException as e:
        logger.warning(f"Error detalle {voucher.get('number')}: {e}")
        return None


def main():
    start_time = time.time()

    # Año a re-extraer — viene del workflow como variable de entorno
    year_str = os.environ.get("BACKFILL_YEAR", "").strip()
    if not year_str.isdigit():
        logger.error(f"BACKFILL_YEAR inválido: '{year_str}'. Debe ser un número (ej: 2023).")
        raise SystemExit(1)

    year       = int(year_str)
    from_date  = f"{year}-01-01"
    to_date    = f"{year}-12-31"
    sheet_name = f"hist_details_{year}"

    logger.info(f"=== INICIO backfill: {from_date} → {to_date} → pestaña '{sheet_name}' ===")

    # 1. Obtener todos los encabezados del año
    page         = 0
    total_pages  = 1
    all_vouchers = []

    while page < total_pages:
        logger.info(f"Encabezados página {page + 1} / {total_pages}...")
        result = get_voucher_list(TOKEN, page=page, from_date=from_date, to_date=to_date)
        if result and result.get("items"):
            all_vouchers.extend(result["items"])
            total_items    = result.get("totalItems", 0)
            items_per_page = result.get("itemsPerPage", 100)
            total_pages    = -(-total_items // items_per_page)
            page += 1
        else:
            logger.warning(f"Sin datos en página {page}. Deteniendo.")
            break

    logger.info(f"Total comprobantes a detallar: {len(all_vouchers)}")

    # 2. Obtener detalle de cada comprobante
    detailed_rows = []
    timestamp     = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for i, voucher in enumerate(all_vouchers, 1):
        if i % 500 == 0:
            elapsed = time.time() - start_time
            logger.info(f"  Progreso: {i}/{len(all_vouchers)} comprobantes ({elapsed:.0f}s)")

        detail_response = get_voucher_detail(TOKEN, voucher)
        if not detail_response:
            continue
        details = detail_response.get("detail")
        if not details:
            continue

        # bussinessCenterId del encabezado como fallback (confirmado = None en esta API,
        # pero lo dejamos por si acaso)
        header_biz = (
            detail_response.get("bussinessCenterId")
            or (detail_response.get("header") or {}).get("bussinessCenterId")
            or voucher.get("bussinessCenterId")
            or ""
        )

        for line in details:
            line_biz = line.get("bussinessCenterId") or header_biz or ""

            detailed_rows.append({
                "detailLine":             line.get("detailLine"),
                "accountCode":            line.get("accountCode"),
                "debit":                  line.get("debit", 0),
                "credit":                 line.get("credit", 0),
                "secondaryDebit":         line.get("secondaryDebit", 0),
                "secondaryCredit":        line.get("secondaryCredit", 0),
                "exchangeRate":           line.get("exchangeRate", 0),
                "comment":                line.get("comment"),
                "fileId":                 line.get("fileId"),
                "documentType":           line.get("documentType"),
                "documentSeries":         line.get("documentSeries"),
                "documentNumber":         line.get("documentNumber"),
                "documentExpirationDate": line.get("documentExpirationDate"),
                "originDocumentData":     line.get("originDocumentData"),
                "bussinessCenterId":      line_biz,
                "classifier1Id":          line.get("classifier1Id"),
                "classifier2Id":          line.get("classifier2Id"),
                "movementTypeId":         line.get("movementTypeId"),
                "movementSeries":         line.get("movementSeries"),
                "movementNumber":         line.get("movementNumber"),
                "voucherNumber":          voucher.get("number"),
                "voucherType":            voucher.get("voucherType"),
                "fiscalYear":             voucher.get("fiscalYear"),
                "entryDate":              voucher.get("entryDate"),
                "date":                   voucher.get("date"),     # ← columna date desde API
                "controlDate":            timestamp,
            })

    if not detailed_rows:
        logger.warning("No se obtuvieron detalles. No se sube nada.")
        return

    df = pd.DataFrame(detailed_rows)
    logger.info(f"Total líneas extraídas para {year}: {len(df)}")
    logger.info(f"Distribución por mes: {df['date'].str[:7].value_counts().sort_index().to_dict()}")

    upload_dataframe(df, subfolder="", filename=f"{sheet_name}.csv", logger=logger)

    duration = time.time() - start_time
    logger.info(f"=== FIN backfill {year}: {duration:.1f}s ===")


if __name__ == "__main__":
    main()
