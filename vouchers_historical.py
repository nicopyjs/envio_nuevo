# -*- coding: utf-8 -*-
"""
vouchers_historical.py
Extrae el historial completo de encabezados de comprobantes desde 2020
hasta el año en curso y sube el resultado como CSV a SharePoint.

Este script es PESADO (muchas páginas de API). Se recomienda ejecutarlo
semanalmente (no diario) via el workflow etl_historico.yml.

Variable de entorno requerida:
    DEFONTANA_TOKEN  - JWT de autenticación de la API de Defontana
"""

import os
import time
import requests
import pandas as pd
from datetime import datetime
from logger_etl import setup_logger
from sharepoint_uploader import upload_dataframe

ETL_NAME = "vouchers_historical"
logger = setup_logger(ETL_NAME)

URL_VOUCHER_LIST = "https://api.defontana.com/api/Accounting/GetVoucherList"
TOKEN = os.environ["DEFONTANA_TOKEN"]

FROM_DATE = "2020-01-01"


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


def main():
    start_time = time.time()
    to_date = f"{datetime.today().year}-12-31"
    logger.info(f"=== INICIO: extracción vouchers históricos {FROM_DATE} → {to_date} ===")

    page = 0
    total_pages = 1
    all_vouchers = []
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    while page < total_pages:
        logger.info(f"Página {page + 1} / {total_pages}...")
        result = get_voucher_list(TOKEN, page=page, from_date=FROM_DATE, to_date=to_date)
        if result and result.get("items"):
            for voucher in result["items"]:
                voucher["controlDate"] = timestamp
                all_vouchers.append(voucher)
            total_items    = result.get("totalItems", 0)
            items_per_page = result.get("itemsPerPage", 100)
            total_pages    = -(-total_items // items_per_page)
            page += 1
        else:
            logger.warning(f"Sin datos o error en página {page}. Deteniendo.")
            break

    if not all_vouchers:
        logger.warning("No se obtuvieron comprobantes históricos. No se sube archivo.")
        return

    df = pd.DataFrame(all_vouchers)
    logger.info(f"Total registros históricos: {len(df)}")

    upload_dataframe(df, subfolder="Historico", filename="historical_vouchers.csv", logger=logger)

    duration = time.time() - start_time
    logger.info(f"=== FIN: {duration:.1f}s ===")


if __name__ == "__main__":
    main()
