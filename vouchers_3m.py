# -*- coding: utf-8 -*-
"""
vouchers_3m.py
Extrae los encabezados de comprobantes de los últimos ~90 días (o desde
inicio de año si es antes de los 90 días) desde la API de Defontana y
sube el resultado como CSV a SharePoint.

Variable de entorno requerida:
    DEFONTANA_TOKEN  - JWT de autenticación de la API de Defontana
"""

import os
import time
import requests
import pandas as pd
from datetime import datetime, timedelta
from logger_etl import setup_logger
from google_spreadsheet_uploader import upload_dataframe

ETL_NAME = "vouchers_3m"
logger = setup_logger(ETL_NAME)

URL_VOUCHER_LIST = "https://api.defontana.com/api/Accounting/GetVoucherList"
TOKEN = os.environ["DEFONTANA_TOKEN"]


def get_voucher_list(token, items_per_page=100, page=0, from_date=None, to_date=None):
    headers = {"Authorization": f"Bearer {token}"}
    params = {"ItemsPerPage": items_per_page, "Page": page}
    if from_date:
        params["FromDate"] = from_date
    if to_date:
        params["ToDate"] = to_date
    try:
        response = requests.get(URL_VOUCHER_LIST, headers=headers, params=params, timeout=300)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Error al obtener lista de comprobantes página {page}: {e}")
        return None


def main():
    start_time = time.time()
    logger.info("=== INICIO: extracción vouchers encabezados (ventana 3 meses) ===")

    to_date = datetime.today().strftime("%Y-%m-%d")
    first_day_of_year = datetime(datetime.today().year, 1, 1).strftime("%Y-%m-%d")
    from_date = (datetime.today() - timedelta(days=90)).strftime("%Y-%m-%d")

    if from_date < first_day_of_year:
        from_date = first_day_of_year
        logger.info(f"Ajuste a inicio de año. Rango: {from_date} → {to_date}")
    else:
        logger.info(f"Rango: {from_date} → {to_date}")

    page = 0
    total_pages = 1
    all_vouchers = []
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    while page < total_pages:
        logger.info(f"Solicitando página {page + 1} / {total_pages}...")
        result = get_voucher_list(TOKEN, page=page, from_date=from_date, to_date=to_date)
        if result and result.get("items"):
            for voucher in result["items"]:
                voucher["controlDate"] = timestamp
                all_vouchers.append(voucher)
            total_items = result.get("totalItems", 0)
            items_per_page = result.get("itemsPerPage", 100)
            total_pages = -(-total_items // items_per_page)
            page += 1
        else:
            logger.warning(f"Sin datos o error en página {page}. Deteniendo.")
            break

    if not all_vouchers:
        logger.warning("No se obtuvieron comprobantes. No se sube archivo.")
        return

    df = pd.DataFrame(all_vouchers)
    logger.info(f"Total registros obtenidos: {len(df)}")

    upload_dataframe(df, subfolder="TresMeses", filename="three_months_vouchers.csv", logger=logger)

    duration = time.time() - start_time
    logger.info(f"=== FIN: {duration:.1f}s ===")


if __name__ == "__main__":
    main()
