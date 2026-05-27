# -*- coding: utf-8 -*-
"""
vouchers_detail_3m.py
Extrae el detalle línea a línea de los comprobantes de los últimos ~90 días
desde la API de Defontana y sube el resultado como CSV a SharePoint.

Variable de entorno requerida:
    DEFONTANA_TOKEN  - JWT de autenticación de la API de Defontana
"""

import os
import time
import requests
import pandas as pd
from datetime import datetime, timedelta
from logger_etl import setup_logger
from sharepoint_uploader import upload_dataframe

ETL_NAME = "vouchers_detail_3m"
logger = setup_logger(ETL_NAME)

URL_VOUCHER_LIST   = "https://api.defontana.com/api/Accounting/GetVoucherList"
URL_VOUCHER_DETAIL = "https://api.defontana.com/api/Accounting/GetVoucher"
TOKEN = os.environ["DEFONTANA_TOKEN"]


def get_voucher_list(token, items_per_page=100, page=0, from_date=None, to_date=None):
    headers = {"Authorization": f"Bearer {token}"}
    params  = {"ItemsPerPage": items_per_page, "Page": page}
    if from_date:
        params["FromDate"] = from_date
    if to_date:
        params["ToDate"] = to_date
    try:
        response = requests.get(URL_VOUCHER_LIST, headers=headers, params=params, timeout=300)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Error lista página {page}: {e}")
        return None


def get_voucher_detail(token, voucher):
    headers = {"Authorization": f"Bearer {token}"}
    params = {
        "VoucherType": voucher["voucherType"],
        "Number":      voucher["number"],
        "FiscalYear":  voucher["fiscalYear"],
        "Isopening":   False,
    }
    try:
        response = requests.get(URL_VOUCHER_DETAIL, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.warning(f"Error detalle comprobante {voucher.get('number')}: {e}")
        return None


def main():
    start_time = time.time()
    logger.info("=== INICIO: extracción detalle vouchers (ventana 3 meses) ===")

    to_date          = datetime.today().strftime("%Y-%m-%d")
    first_day_of_year = datetime(datetime.today().year, 1, 1).strftime("%Y-%m-%d")
    from_date        = (datetime.today() - timedelta(days=90)).strftime("%Y-%m-%d")

    if from_date < first_day_of_year:
        from_date = first_day_of_year
        logger.info(f"Ajuste a inicio de año. Rango: {from_date} → {to_date}")
    else:
        logger.info(f"Rango: {from_date} → {to_date}")

    # 1. Obtener lista de encabezados
    page = 0
    total_pages = 1
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
            logger.warning(f"Sin datos o error en página {page}. Deteniendo.")
            break

    logger.info(f"Total comprobantes a detallar: {len(all_vouchers)}")

    # 2. Obtener detalle línea a línea
    detailed_rows = []
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    logged_keys     = False
    filled_from_hdr = 0

    for voucher in all_vouchers:
        detail_response = get_voucher_detail(TOKEN, voucher)
        if not detail_response:
            continue
        details = detail_response.get("detail")
        if not details:
            continue

        # Diagnóstico: estructura de respuesta (una vez)
        if not logged_keys:
            logger.info(f"[ESTRUCTURA GetVoucher] claves raíz: {list(detail_response.keys())}")
            logged_keys = True

        # bussinessCenterId del encabezado → fallback para líneas vacías
        header_biz = (
            detail_response.get("bussinessCenterId")
            or (detail_response.get("header") or {}).get("bussinessCenterId")
            or voucher.get("bussinessCenterId")
            or ""
        )

        for line in details:
            line_biz = line.get("bussinessCenterId") or ""
            if not line_biz and header_biz:
                line_biz = header_biz
                filled_from_hdr += 1

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
                "date":                   voucher.get("date"),
                "controlDate":            timestamp,
            })

    logger.info(f"Líneas con área heredada del encabezado: {filled_from_hdr}")

    if not detailed_rows:
        logger.warning("No se obtuvieron detalles. No se sube archivo.")
        return

    df = pd.DataFrame(detailed_rows)
    logger.info(f"Total líneas de detalle: {len(df)}")

    upload_dataframe(df, subfolder="TresMeses", filename="three_months_voucher_details.csv", logger=logger)

    duration = time.time() - start_time
    logger.info(f"=== FIN: {duration:.1f}s ===")


if __name__ == "__main__":
    main()
