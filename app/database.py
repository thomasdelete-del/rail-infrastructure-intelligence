import os

from sqlalchemy import create_engine, text

DATABASE_URL = os.getenv("DATABASE_URL")
_engine = None


def get_engine():
    global _engine
    if _engine is None:
        if not DATABASE_URL:
            raise RuntimeError("DATABASE_URL is not configured")
        _engine = create_engine(DATABASE_URL, pool_pre_ping=True)
    return _engine


def database_health() -> bool:
    with get_engine().connect() as connection:
        connection.execute(text("SELECT 1"))
    return True
