import asyncio
import json

from app.services.platform_matching import sync_all_stations


def main() -> None:
    print(json.dumps(asyncio.run(sync_all_stations()), default=str, ensure_ascii=False))


if __name__ == "__main__":
    main()
