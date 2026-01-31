"""
MCP Server for WAGO WebVisu
Exposes light switch controls as MCP tools for Claude Desktop integration
"""

import os
import logging
import json
import httpx
import uvicorn

from mcp.server import Server
from mcp.server.sse import SseServerTransport
from mcp.types import Tool, TextContent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mcp-server")

# Configuration
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8080")

# Create MCP server
mcp_server = Server("wago-webvisu-adapter")

# Create SSE transport
sse = SseServerTransport("/messages/")


@mcp_server.list_tools()
async def list_tools() -> list[Tool]:
    """List available tools."""
    return [
        Tool(
            name="list_lights",
            description="List all available light switches in the WAGO home automation system. Each switch shows which lights it controls (firstPress and optionally secondPress for dual-function switches).",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": [],
            },
        ),
        Tool(
            name="get_light_status",
            description="Get the current on/off status of a specific light switch. Use light_id like 'kylpyhuone-1' or 'keittio-1'. Shows firstPress (what the switch controls) and secondPress for dual-function switches.",
            inputSchema={
                "type": "object",
                "properties": {
                    "light_id": {
                        "type": "string",
                        "description": "The ID of the light switch (e.g., 'kylpyhuone-1', 'keittio-1')",
                    },
                },
                "required": ["light_id"],
            },
        ),
        Tool(
            name="toggle_light",
            description="Toggle a light switch on or off. Some switches have dual functions: use function=1 (default) for firstPress or function=2 for secondPress. Example: to toggle 'Sauna siivousvalo' on switch 'kylpyhuone-2', use function=2.",
            inputSchema={
                "type": "object",
                "properties": {
                    "light_id": {
                        "type": "string",
                        "description": "The ID of the light switch to toggle (e.g., 'kylpyhuone-1', 'keittio-1')",
                    },
                    "function": {
                        "type": "integer",
                        "enum": [1, 2],
                        "default": 1,
                        "description": "Which function to toggle: 1 for firstPress (default), 2 for secondPress (only for dual-function switches)",
                    },
                },
                "required": ["light_id"],
            },
        ),
    ]


@mcp_server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Handle tool calls."""
    logger.info(f"Tool called: {name} with args: {arguments}")

    async with httpx.AsyncClient(base_url=API_BASE_URL, timeout=30.0) as client:
        try:
            if name == "list_lights":
                response = await client.get("/api/lights")
                response.raise_for_status()
                return [TextContent(type="text", text=response.text)]

            elif name == "get_light_status":
                light_id = arguments.get("light_id")
                if not light_id:
                    return [TextContent(type="text", text='{"error": "light_id is required"}')]

                response = await client.get(f"/api/lights/{light_id}")
                response.raise_for_status()
                return [TextContent(type="text", text=response.text)]

            elif name == "toggle_light":
                light_id = arguments.get("light_id")
                if not light_id:
                    return [TextContent(type="text", text='{"error": "light_id is required"}')]

                # Support dual-function switches with function parameter
                function_num = arguments.get("function", 1)
                url = f"/api/lights/{light_id}/toggle"
                if function_num == 2:
                    url += "?function=2"

                response = await client.post(url)
                response.raise_for_status()
                return [TextContent(type="text", text=response.text)]

            else:
                return [TextContent(type="text", text=f'{{"error": "Unknown tool: {name}"}}')]

        except httpx.HTTPStatusError as e:
            error_text = e.response.text if e.response else str(e)
            return [TextContent(type="text", text=f'{{"error": "API error", "message": "{error_text}"}}')]
        except httpx.RequestError as e:
            return [TextContent(type="text", text=f'{{"error": "Connection error", "message": "{str(e)}"}}')]


async def handle_sse(scope, receive, send):
    """Handle SSE connections."""
    logger.info("New SSE connection")
    async with sse.connect_sse(scope, receive, send) as streams:
        await mcp_server.run(
            streams[0], streams[1], mcp_server.create_initialization_options()
        )


async def handle_health(scope, receive, send):
    """Handle health check."""
    await send({
        "type": "http.response.start",
        "status": 200,
        "headers": [[b"content-type", b"application/json"]],
    })
    await send({
        "type": "http.response.body",
        "body": b'{"status": "ok", "service": "wago-webvisu-mcp"}',
    })


async def app(scope, receive, send):
    """Main ASGI application with routing."""
    if scope["type"] == "http":
        path = scope["path"]
        method = scope["method"]

        if path == "/health" and method == "GET":
            await handle_health(scope, receive, send)
        elif path == "/sse" and method == "GET":
            await handle_sse(scope, receive, send)
        elif path.startswith("/messages") and method == "POST":
            await sse.handle_post_message(scope, receive, send)
        else:
            # 404
            await send({
                "type": "http.response.start",
                "status": 404,
                "headers": [[b"content-type", b"text/plain"]],
            })
            await send({
                "type": "http.response.body",
                "body": b"Not Found",
            })
    elif scope["type"] == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return


def main():
    """Run the MCP server."""
    host = os.environ.get("MCP_HOST", "0.0.0.0")
    port = int(os.environ.get("MCP_PORT", "3002"))

    logger.info(f"Starting WAGO WebVisu MCP Server")
    logger.info(f"  URL: http://{host}:{port}/sse")
    logger.info(f"  Health: http://{host}:{port}/health")
    logger.info(f"  API Backend: {API_BASE_URL}")

    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
