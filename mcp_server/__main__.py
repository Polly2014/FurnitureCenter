import argparse
import asyncio

from mcp_server.server import mcp


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the 家具共享平台 MCP server")
    parser.add_argument(
        "--transport",
        choices=("stdio", "streamable-http"),
        default="stdio",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8820)
    args = parser.parse_args()

    if args.transport == "stdio":
        asyncio.run(mcp.run_stdio_async())
    else:
        asyncio.run(mcp.run_streamable_http_async(host=args.host, port=args.port))


if __name__ == "__main__":
    main()
