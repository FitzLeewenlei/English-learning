#!/usr/bin/env python3
"""Local static server with byte-range support for audio seeking.

Run with the cloud environment's aiohttp installation, or install aiohttp first.
This is development tooling; GitHub Pages continues to serve the static files.
"""

import argparse
from pathlib import Path

from aiohttp import web


def create_app():
    root = Path(__file__).resolve().parents[1]
    app = web.Application()

    async def index(_request):
        return web.FileResponse(root / "index.html")

    app.router.add_get("/", index)
    app.router.add_static("/", root, show_index=False)
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8002)
    args = parser.parse_args()
    web.run_app(create_app(), host=args.host, port=args.port)
