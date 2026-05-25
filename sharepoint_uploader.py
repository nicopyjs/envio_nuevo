"""
sharepoint_uploader.py
Módulo compartido para autenticar con Azure AD y subir archivos CSV al
OneDrive for Business de un usuario, usando Microsoft Graph API con
credenciales de aplicación (client credentials flow).

Variables de entorno requeridas:
    AZURE_TENANT_ID     - ID del directorio (inquilino) de Azure AD
    AZURE_CLIENT_ID     - ID de la aplicación registrada (defontana-etl)
    AZURE_CLIENT_SECRET - Secreto de cliente generado en Azure AD
    ONEDRIVE_USER       - Email del usuario dueño del OneDrive destino
                          (ej: npalma@nebchile.cl)
    ONEDRIVE_FOLDER     - Carpeta base en OneDrive (ej: Defontana ETL)
"""

import os
import msal
import requests

# ── Configuración desde variables de entorno ──────────────────────────────────
TENANT_ID     = os.environ["AZURE_TENANT_ID"]
CLIENT_ID     = os.environ["AZURE_CLIENT_ID"]
CLIENT_SECRET = os.environ["AZURE_CLIENT_SECRET"]
OD_USER       = os.environ["ONEDRIVE_USER"]           # npalma@nebchile.cl
OD_FOLDER     = os.environ.get("ONEDRIVE_FOLDER", "Defontana ETL")

GRAPH_SCOPE   = ["https://graph.microsoft.com/.default"]
GRAPH_BASE    = "https://graph.microsoft.com/v1.0"


def _get_token() -> str:
    """Obtiene un access token de Azure AD usando client credentials."""
    app = msal.ConfidentialClientApplication(
        CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        client_credential=CLIENT_SECRET,
    )
    result = app.acquire_token_for_client(scopes=GRAPH_SCOPE)
    if "access_token" not in result:
        raise RuntimeError(
            f"Error al obtener token de Azure AD: {result.get('error_description', result)}"
        )
    return result["access_token"]


def upload_dataframe(df, subfolder: str, filename: str, logger=None) -> None:
    """
    Sube un DataFrame como CSV al OneDrive for Business del usuario configurado.

    Args:
        df        : DataFrame de pandas a exportar.
        subfolder : Subcarpeta dentro de OD_FOLDER (ej: 'TresMeses', 'Historico').
        filename  : Nombre del archivo CSV (ej: 'three_months_vouchers.csv').
        logger    : Logger opcional para registrar el resultado.
    """
    token = _get_token()

    csv_bytes = df.to_csv(index=False).encode("utf-8")
    remote_path = f"{OD_FOLDER}/{subfolder}/{filename}"

    # Endpoint: OneDrive for Business del usuario vía Graph API (app permissions)
    url = f"{GRAPH_BASE}/users/{OD_USER}/drive/root:/{remote_path}:/content"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type":  "text/plain",
    }

    response = requests.put(url, headers=headers, data=csv_bytes, timeout=60)

    if response.status_code in (200, 201):
        msg = f"[OK] Subido a OneDrive ({OD_USER}): {remote_path} ({len(df)} filas)"
        print(msg)
        if logger:
            logger.info(msg)
    else:
        error_msg = (
            f"[ERROR] No se pudo subir {remote_path}. "
            f"HTTP {response.status_code}: {response.text[:300]}"
        )
        print(error_msg)
        if logger:
            logger.error(error_msg)
        response.raise_for_status()
