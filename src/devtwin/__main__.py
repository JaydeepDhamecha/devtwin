"""CLI entry point: `devtwin` starts the MCP server over stdio."""

from __future__ import annotations

import argparse
import sys

from devtwin import __version__


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="devtwin",
        description=(
            "DevTwin MCP server -- gives AI coding agents a live, structured "
            "understanding of your local development environment."
        ),
    )
    parser.add_argument("--version", action="version", version=f"devtwin-mcp {__version__}")
    parser.parse_args()

    from devtwin.server import main as run_server

    try:
        run_server()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
