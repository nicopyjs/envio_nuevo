# Documentación de Infraestructura — ETL Defontana
**New Energy Business SpA**
Última actualización: mayo 2026

---

## 1. Resumen General

Este sistema extrae datos contables desde la API de Defontana, los almacena en Google Sheets y genera análisis financieros por área de negocio. Reemplaza una VM de GCP (~$40/mes) que alimentaba una base de datos MSSQL. La nueva arquitectura es completamente serverless y sin costo de infraestructura.

**Flujo general:**
Defontana API → GitHub Actions (Python) → Google Sheets → Apps Script (P&L) → Looker Studio / Power BI

---

## 2. Componentes del Sistema

### 2.1 GitHub Actions — ETL Diario
**Repositorio:** `nicopyjs/envio_nuevo` (privado)
**Archivo:** `.github/workflows/etl_diario.yml`
**Ejecución:** Lunes a viernes a las 10:00 UTC (06:00 hora Chile invierno CLT / 07:00 en verano CLST)
**Timeout:** 300 minutos
**Trigger manual disponible:** sí (workflow_dispatch)

Ejecuta tres scripts en secuencia:

| Paso | Script | Descripción | Destino en Sheets |
|------|--------|-------------|-------------------|
| 1/3 | `vouchers_3m.py` | Encabezados de comprobantes últimos 90 días | pestaña `three_months_vouchers` |
| 2/3 | `vouchers_detail_3m.py` | Detalle línea a línea últimos 90 días | pestaña `three_months_voucher_details` |
| 3/3 | `vouchers_detail_year.py` | Detalle completo del año en curso (1 enero → hoy) | pestaña `hist_details_YYYY` |

### 2.2 GitHub Actions — ETL Histórico
**Archivo:** `.github/workflows/etl_historico.yml`
**Ejecución:** Domingos a las 10:00 UTC
**Script:** `vouchers_historical.py`
**Descripción:** Extrae todos los encabezados de comprobantes desde 2020 hasta el año actual.
**Destino:** pestaña `historical_vouchers`

### 2.3 Google Sheets — Base de Datos
**Spreadsheet ID:** `1b4QPLY0otfzhSkJ7QQscJALJu7DssHi9w1XCad2LI48`
**Acceso:** Service Account `defontana-etl@defontana-centralizacion-datos.iam.gserviceaccount.com`

Estructura de pestañas:

| Pestaña | Contenido | Fuente | Actualización |
|---------|-----------|--------|---------------|
| `historical_vouchers` | Encabezados de todos los comprobantes (2020→presente) | ETL histórico | Semanal (domingos) |
| `three_months_vouchers` | Encabezados últimos 90 días | ETL diario script 1/3 | Diaria |
| `three_months_voucher_details` | Detalle línea a línea últimos 90 días | ETL diario script 2/3 | Diaria |
| `hist_details_2021` | Detalle histórico año 2021 | Carga única local | Estático |
| `hist_details_2022` | Detalle histórico año 2022 | Carga única local | Estático |
| `hist_details_2023` | Detalle histórico año 2023 | Carga única local | Estático |
| `hist_details_2024` | Detalle histórico año 2024 | Carga única local | Estático |
| `hist_details_2025` | Detalle histórico año 2025 | Carga única local | Estático |
| `hist_details_2026` | Detalle año en curso (crece diariamente) | ETL diario script 3/3 | Diaria (reemplazo completo) |
| `pnl_data` | P&L por área y mes (formato largo/tidy) | Apps Script | Manual o programado |
| `pnl_resumen` | Tabla pivote P&L por área | Apps Script | Manual o programado |

---

## 3. Scripts Python

Todos los scripts están en el repositorio `envio_nuevo/`. Requieren Python 3.11.

### `sharepoint_uploader.py`
Módulo de utilidad para subir DataFrames a Google Sheets. A pesar del nombre (herencia del sistema anterior), conecta con Google Sheets vía `gspread`. Lee las credenciales y el ID del spreadsheet desde variables de entorno. Sube en lotes de 50.000 filas para evitar timeouts.

**Variables de entorno requeridas:**
- `GOOGLE_SERVICE_ACCOUNT_JSON` — contenido JSON de la service account
- `GOOGLE_SPREADSHEET_ID` — ID del Google Spreadsheet

### `vouchers_3m.py`
Extrae encabezados de comprobantes de los últimos 90 días (o desde el 1 de enero si los 90 días caen antes de esa fecha). Llama a `GetVoucherList` de la API de Defontana paginando de 100 en 100. Sube todos los campos raw que devuelve la API.

### `vouchers_detail_3m.py`
Extrae el detalle línea a línea de los mismos comprobantes del script anterior. Por cada comprobante llama a `GetVoucher` para obtener sus líneas contables. Incluye lógica de fallback: si una línea no tiene `bussinessCenterId`, intenta obtenerlo del encabezado del comprobante en la respuesta de la API.

### `vouchers_detail_year.py`
Igual que `vouchers_detail_3m.py` pero cubre todo el año en curso (1 enero → hoy). Se reemplaza completo en cada ejecución. El nombre de la pestaña se genera dinámicamente (`hist_details_2026`, `hist_details_2027`, etc.). Este script tarda aproximadamente 15-20 minutos en ejecutarse.

### `vouchers_historical.py`
Extrae todos los encabezados de comprobantes desde el 1 de enero de 2020 hasta el 31 de diciembre del año actual. Se ejecuta semanalmente porque es pesado (muchas páginas de API).

### `logger_etl.py`
Módulo de logging que escribe solo a stdout (compatible con GitHub Actions, sin archivos en disco).

### `upload_historico_one_time.py`
Script de uso único para carga inicial de CSV históricos (2021-2025) desde el equipo local. No se ejecuta en GitHub Actions. Requiere la ruta local al JSON de la service account. Ya fue ejecutado — los datos históricos están en Google Sheets.

### `requirements.txt`
```
requests>=2.31.0
pandas>=2.1.0
gspread>=6.0.0
google-auth>=2.28.0
```

---

## 4. Google Apps Script — Análisis P&L

**Ubicación:** dentro del Google Spreadsheet → Extensiones → Apps Script
**Archivo fuente:** `appscript_pnl.js` en el repositorio

Genera dos pestañas de análisis financiero a partir de las pestañas `hist_details_*`:

### Lógica contable
- Cuentas que comienzan con `3` → **Ingresos** (ingreso neto = credit − debit)
- Cuentas que comienzan con `4` → **Gastos** (gasto neto = debit − credit)

### Áreas de negocio (primeros 3 caracteres del bussinessCenterId)
| Código | Nombre |
|--------|--------|
| RCT | Refacciones |
| SST | Servicio Técnico |
| INT | Instalaciones |
| GNN | General |

### JOIN intra-hoja (v_combined_voucher_details)
El script replica la lógica del VIEW SQL original (`v_combined_voucher_details`). Aproximadamente el 74% de las líneas contables no tienen `bussinessCenterId` asignado a nivel de línea en Defontana. Para recuperarlos, el script hace dos pasadas por cada hoja:

1. **Pasada 1:** Construye un mapa `voucherType|voucherNumber|fiscalYear → bussinessCenterId` con las líneas que sí tienen área.
2. **Pasada 2:** Para las líneas sin área, busca en ese mapa si otro asiento del mismo comprobante tiene área, y lo hereda.

Esto aumenta la cobertura de ~26% a ~65% de líneas atribuidas a un área.

### Lookup de fechas (para datos históricos 2021-2023)
Los CSV históricos del sistema MSSQL original no incluían columna `date`. El script obtiene la fecha de transacción desde la pestaña `historical_vouchers` usando la misma clave compuesta.

### Funciones disponibles en el menú
- **Generar todo (P&L + Resumen):** ejecuta ambas funciones en secuencia
- **Solo P&L data:** genera `pnl_data` (formato largo, fuente para Looker Studio)
- **Solo tabla resumen:** genera `pnl_resumen` (tabla pivote por área y mes)
- **Diagnosticar columnas:** muestra las columnas de cualquier pestaña (útil para depuración)

---

## 5. Credenciales y Secrets

### GitHub Actions Secrets
Configurados en `nicopyjs/envio_nuevo` → Settings → Secrets and variables → Actions:

| Secret | Descripción |
|--------|-------------|
| `DEFONTANA_TOKEN` | JWT de autenticación de la API de Defontana. Expira periódicamente — renovar cuando el ETL falle con error 401. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Contenido completo del archivo JSON de la service account de Google Cloud. |
| `GOOGLE_SPREADSHEET_ID` | ID del Google Spreadsheet (`1b4QPLY0otfzhSkJ7QQscJALJu7DssHi9w1XCad2LI48`). |

> **Nota:** Los secrets `ONEDRIVE_FOLDER` y `ONEDRIVE_USER` del sistema anterior pueden eliminarse — ya no se usan.

### Google Cloud
**Proyecto:** `defontana-centralizacion-datos`
**Service Account:** `defontana-etl@defontana-centralizacion-datos.iam.gserviceaccount.com`
**APIs habilitadas:** Google Sheets API, Google Drive API
**Archivo de credenciales local:** `defontana-centralizacion-datos-d170f4586c8c.json` (guardado en Downloads, solo para uso local)

---

## 6. API de Defontana

**Base URL:** `https://api.defontana.com/api/Accounting/`
**Autenticación:** Bearer Token (JWT) en header `Authorization`

| Endpoint | Uso |
|----------|-----|
| `GetVoucherList` | Lista paginada de encabezados de comprobantes. Parámetros: `FromDate`, `ToDate`, `ItemsPerPage`, `Page`. |
| `GetVoucher` | Detalle completo de un comprobante. Parámetros: `VoucherType`, `Number`, `FiscalYear`, `Isopening`. Devuelve objeto con claves: `header`, `detail`, `success`, `message`, `exceptionMessage`. |

**Nota sobre `bussinessCenterId`:** La API no devuelve este campo en `GetVoucherList` ni en el objeto `header` de `GetVoucher`. Solo aparece a nivel de línea individual en el array `detail`, y solo cuando está explícitamente asignado en Defontana (~26% de las líneas).

---

## 7. Mantenimiento

### Renovar el token de Defontana
Cuando el ETL falle con error 401 (Unauthorized):
1. Obtener un nuevo JWT desde Defontana (login o panel de API)
2. Ir a GitHub → Settings → Secrets → `DEFONTANA_TOKEN` → Update
3. Ejecutar el workflow manualmente para verificar

### Agregar un nuevo año histórico
Cuando comience un nuevo año (ej: 2027):
1. El script `vouchers_detail_year.py` automáticamente creará `hist_details_2027`
2. El año 2026 quedará estático en su pestaña (el script solo procesa el año en curso)
3. Si se necesita el detalle completo de 2026 actualizado, ejecutar el workflow antes del 31 de diciembre

### Verificar que el ETL está corriendo
- GitHub → Actions → ETL Defontana - Diario → ver historial de ejecuciones
- Cada ejecución exitosa actualiza `three_months_voucher_details` y `hist_details_YYYY` en Sheets

### Actualizar el P&L en Google Sheets
Abrir el spreadsheet → menú `📊 Análisis Defontana` → `▶ Generar todo`. Tarda 1-2 minutos dependiendo del volumen de datos.

---

## 8. Arquitectura Anterior (referencia)

| Componente | Sistema anterior | Sistema actual |
|------------|-----------------|----------------|
| Ejecución | VM GCP Windows + Task Scheduler | GitHub Actions (serverless) |
| Almacenamiento | MSSQL Server en VM | Google Sheets |
| Costo mensual | ~$40 USD | $0 |
| Disponibilidad | Dependía de que la VM no cayera | Alta disponibilidad (GitHub infra) |
| Conexión Power BI | Conector SQL Server | Conector Google Sheets |
| Vista combinada | `v_combined_voucher_details` (SQL VIEW) | JOIN intra-hoja en Apps Script |

---

## 9. Diagrama de Flujo

```
┌─────────────────┐
│  API Defontana  │
│  (JWT Token)    │
└────────┬────────┘
         │ HTTPS
         ▼
┌─────────────────────────────────────┐
│       GitHub Actions                │
│  etl_diario.yml (L-V 06:00 Chile)   │
│  ┌──────────────────────────────┐   │
│  │ 1/3 vouchers_3m.py           │   │
│  │ 2/3 vouchers_detail_3m.py    │   │
│  │ 3/3 vouchers_detail_year.py  │   │
│  └──────────────────────────────┘   │
│                                     │
│  etl_historico.yml (Dom 10:00 UTC)  │
│  ┌──────────────────────────────┐   │
│  │     vouchers_historical.py   │   │
│  └──────────────────────────────┘   │
└────────────────────┬────────────────┘
                     │ gspread API
                     ▼
┌─────────────────────────────────────┐
│         Google Sheets               │
│  historical_vouchers                │
│  three_months_vouchers              │
│  three_months_voucher_details       │
│  hist_details_2021 ... 2026         │
└──────────┬─────────────┬────────────┘
           │             │
           ▼             ▼
┌──────────────┐  ┌──────────────────┐
│ Apps Script  │  │    Power BI      │
│ (P&L calc.)  │  │ (conector Sheets)│
└──────┬───────┘  └──────────────────┘
       │
       ▼
┌──────────────────┐
│  pnl_data        │
│  pnl_resumen     │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  Looker Studio   │
│  (dashboards)    │
└──────────────────┘
```
