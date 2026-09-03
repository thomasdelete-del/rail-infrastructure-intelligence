from pathlib import Path

from sqlalchemy import create_engine

from app.database import DATABASE_URL


def main():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not configured")
    schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
    engine = create_engine(DATABASE_URL, pool_pre_ping=True)
    raw = engine.raw_connection()
    try:
        with raw.cursor() as cursor:
            cursor.execute(schema)
        raw.commit()
    finally:
        raw.close()
        engine.dispose()


if __name__ == "__main__":
    main()
