"""
google_spreadsheet_uploader.py

Módulo compartido para autenticar con una cuenta de servicio de Google y
escribir DataFrames directamente en pestañas de un Google Spreadsheet.
Equivalente a TRUNCATE + INSERT: borra la pestaña y la reescribe completa.

Variables de entorno requeridas:
    GOOGLE_SERVICE_ACCOUNT_JSON  - Contenido completo del JSON de la service account
    GOOGLE_SPREADSHEET_ID        - ID del spreadsheet destino (de la URL de Google Sheets)
"""

import os
import json
import math
import time
import gspread
from google.oauth2.service_account import Credentials

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

RETRY_ATTEMPTS = 5
RETRY_BASE_DELAY = 2  # segundos, se duplica en cada intento (backoff exponencial)


def _with_retries(func, logger=None, description="operación de Google Sheets"):
    """Reintenta func() ante errores transitorios de la API (5xx)."""
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            return func()
        except gspread.exceptions.APIError as e:
            status = e.response.status_code if e.response is not None else None
            transient = status is not None and 500 <= status < 600
            if not transient or attempt == RETRY_ATTEMPTS:
                raise
            delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
            msg = (f"[WARN] {description} falló (HTTP {status}), "
                   f"reintento {attempt}/{RETRY_ATTEMPTS} en {delay}s...")
            print(msg)
            if logger:
                logger.warning(msg)
            time.sleep(delay)


def _get_client() -> gspread.Client:
    """Autentica con la service account y devuelve un cliente de gspread."""
    raw = os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]
    info = json.loads(raw)
    creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    return gspread.authorize(creds)


def upload_dataframe(df, subfolder: str, filename: str, logger=None) -> None:
    """
    Escribe un DataFrame en una pestaña de Google Sheets.
    La pestaña se identifica por 'filename' (sin extensión).
    Si no existe se crea; si existe se limpia y se reescribe.

    Args:
        df        : DataFrame de pandas a escribir.
        subfolder : No se usa en Google Sheets (se conserva la firma para
                    compatibilidad con los scripts de extracción).
        filename  : Nombre del archivo (ej: 'three_months_vouchers.csv').
                    Se usa como nombre de la pestaña (sin .csv).
        logger    : Logger opcional.
    """
    spreadsheet_id = os.environ["GOOGLE_SPREADSHEET_ID"]
    sheet_name = filename.replace(".csv", "")   # nombre de la pestaña

    client      = _get_client()
    spreadsheet = _with_retries(
        lambda: client.open_by_key(spreadsheet_id),
        logger=logger,
        description=f"abrir spreadsheet '{spreadsheet_id}'",
    )

    needed_rows = max(len(df) + 10, 100)
    needed_cols = len(df.columns) + 2

    # Obtener o crear la pestaña
    try:
        worksheet = spreadsheet.worksheet(sheet_name)
        worksheet.clear()
        if worksheet.row_count < needed_rows or worksheet.col_count < needed_cols:
            worksheet.resize(
                rows=max(worksheet.row_count, needed_rows),
                cols=max(worksheet.col_count, needed_cols),
            )
        if logger:
            logger.info(f"Pestaña '{sheet_name}' limpiada.")
    except gspread.exceptions.WorksheetNotFound:
        worksheet = spreadsheet.add_worksheet(
            title=sheet_name, rows=needed_rows, cols=needed_cols
        )
        if logger:
            logger.info(f"Pestaña '{sheet_name}' creada.")

    # Convertir DataFrame a lista de listas (header + filas)
    # Reemplazar NaN/NaT/None con cadena vacía para Google Sheets
    df_clean = df.fillna("").astype(str)
    values   = [df_clean.columns.tolist()] + df_clean.values.tolist()

    # Google Sheets limita a ~10M celdas por hoja; subir en lotes de 50k filas
    BATCH = 50_000
    total_batches = math.ceil(len(values) / BATCH)

    for i in range(total_batches):
        chunk = values[i * BATCH : (i + 1) * BATCH]
        start_row = i * BATCH + 1
        _with_retries(
            lambda: worksheet.update(
                range_name=f"A{start_row}",
                values=chunk,
                value_input_option="RAW",
            ),
            logger=logger,
            description=f"escribir lote {i + 1}/{total_batches} en '{sheet_name}'",
        )

    msg = f"[OK] Google Sheets '{sheet_name}': {len(df)} filas escritas."
    print(msg)
    if logger:
        logger.info(msg)
