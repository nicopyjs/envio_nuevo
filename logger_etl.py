"""
logger_etl.py
Logger adaptado para GitHub Actions: escribe solo a stdout/stderr,
sin archivos locales (no existe C:/Logs_ETL en el runner de GitHub).
"""

import logging
import sys


def setup_logger(etl_name: str) -> logging.Logger:
    logger = logging.getLogger(etl_name)

    # Evitar handlers duplicados si el módulo se importa varias veces
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s - %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)

    return logger
