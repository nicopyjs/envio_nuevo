# -*- coding: utf-8 -*-
"""
upload_historico_one_time.py
Script de carga ÚNICA de datos históricos a Google Sheets.
Corre esto una sola vez desde tu PC para subir los CSV históricos.

Requisitos (ejecutar una vez):
    pip install gspread google-auth pandas

Uso:
    python upload_historico_one_time.py
"""

import gspread
from google.oauth2.service_account import Credentials
import pandas as pd
import math
import os

# ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────

# Ruta al JSON de la service account (cambia si lo tienes en otro lugar)
CREDS_FILE = r"C:\Users\nikop\Downloads\defontana-centralizacion-datos-d170f4586c8c.json"

# ID del Google Spreadsheet (el mismo que usas en GitHub Actions)
SPREADSHEET_ID = "1b4QPLY0otfzhSkJ7QQscJALJu7DssHi9w1XCad2LI48"

# Carpeta donde están los CSV históricos en tu máquina
BASE_PATH = r"C:\Users\nikop\OneDrive\Desktop\dev\test\script de la vm (sacar de la vm y hacerlo fuera de la vm)\Defontana\Historico"

# Archivos a subir: (nombre del archivo CSV, nombre de la pestaña en Sheets)
FILES = [
    ("historical_vouchers.csv",                   "historical_vouchers"),
    ("historical_voucher_details_2021.csv",        "hist_details_2021"),
    ("historical_voucher_details_2022.csv",        "hist_details_2022"),
    ("historical_voucher_details_2023.csv",        "hist_details_2023"),
    ("historical_voucher_details_2024.csv",        "hist_details_2024"),
    ("historical_voucher_details_2025_part_0.csv", "hist_details_2025"),
]

# ─── CONEXIÓN ─────────────────────────────────────────────────────────────────

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

print("Conectando con Google Sheets...")
creds       = Credentials.from_service_account_file(CREDS_FILE, scopes=SCOPES)
client      = gspread.authorize(creds)
spreadsheet = client.open_by_key(SPREADSHEET_ID)
print(f"Conectado al spreadsheet: {spreadsheet.title}\n")

# ─── CARGA ────────────────────────────────────────────────────────────────────

for filename, sheet_name in FILES:
    csv_path = os.path.join(BASE_PATH, filename)

    if not os.path.exists(csv_path):
        print(f"[OMITIDO] No encontrado: {csv_path}")
        continue

    print(f"→ Subiendo {sheet_name} ...")
    df = pd.read_csv(csv_path).fillna("").astype(str)
    print(f"  {len(df)} filas x {len(df.columns)} columnas")

    # Obtener o crear pestaña
    try:
        ws = spreadsheet.worksheet(sheet_name)
        ws.clear()
        print(f"  Pestaña limpiada.")
    except gspread.exceptions.WorksheetNotFound:
        ws = spreadsheet.add_worksheet(
            title=sheet_name,
            rows=len(df) + 10,
            cols=len(df.columns) + 2
        )
        print(f"  Pestaña creada.")

    # Subir en lotes de 10.000 filas para evitar timeouts
    values = [df.columns.tolist()] + df.values.tolist()
    BATCH  = 10_000

    for i in range(math.ceil(len(values) / BATCH)):
        chunk = values[i * BATCH : (i + 1) * BATCH]
        ws.update(
            range_name=f"A{i * BATCH + 1}",
            values=chunk,
            value_input_option="RAW",
        )
        print(f"  Lote {i + 1} subido ({len(chunk)} filas)")

    print(f"  ✓ {sheet_name} listo\n")

print("=" * 50)
print("✅ Carga histórica completada.")
print("Abre el spreadsheet y verifica las pestañas.")
