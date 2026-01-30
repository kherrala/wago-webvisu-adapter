"""
MCP Server for WAGO WebVisu
Exposes light switch controls as MCP tools for Claude Desktop integration
"""

import os
import logging
import httpx
import uvicorn

from mcp.server import Server
from mcp.server.sse import SseServerTransport
from mcp.types import Tool, TextContent
from starlette.applications import Starlette
from starlette.routing import Route, Mount
from starlette.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mcp-server")

# Configuration
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8080")

# Create MCP server
app = Server("wago-webvisu-adapter")


@app.list_tools()
async def list_tools() -> list[Tool]:
    """List available tools."""
    return [
        Tool(
            name="list_lights",
            description="List all available light switches in the WAGO home automation system",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": [],
            },
        ),
        Tool(
            name="get_light_status",
            description="Get the current on/off status of a specific light switch. Use light_id like 'kylpyhuone-1' or 'keittio-1'.",
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
            description="Toggle a light switch on or off. Use light_id like 'kylpyhuone-1' or 'keittio-1'.",
            inputSchema={
                "type": "object",
                "properties": {
                    "light_id": {
                        "type": "string",
                        "description": "The ID of the light switch to toggle",
                    },
                },
                "required": ["light_id"],
            },
        ),
    ]


@app.call_tool()
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

                response = await client.post(f"/api/lights/{light_id}/toggle")
                response.raise_for_status()
                return [TextContent(type="text", text=response.text)]

            else:
                return [TextContent(type="text", text=f'{{"error": "Unknown tool: {name}"}}')]

        except httpx.HTTPStatusError as e:
            error_text = e.response.text if e.response else str(e)
            return [TextContent(type="text", text=f'{{"error": "API error", "message": "{error_text}"}}')]
        except httpx.RequestError as e:
            return [TextContent(type="text", text=f'{{"error": "Connection error", "message": "{str(e)}"}}')]


def create_starlette_app():
    """Create Starlette app with SSE transport for MCP."""
    sse = SseServerTransport("/messages/")

    async def handle_sse(request):
        async with sse.connect_sse(
            request.scope, request.receive, request._send
        ) as streams:
            await app.run(
                streams[0], streams[1], app.create_initialization_options()
            )

    async def handle_messages(request):
        await sse.handle_post_message(request.scope, request.receive, request._send)

    async def health_check(request):
        return JSONResponse({"status": "ok", "service": "wago-webvisu-mcp"})

    starlette_app = Starlette(
        debug=False,
        routes=[
            Route("/health", health_check),
            Route("/sse", handle_sse),
            Mount("/messages/", routes=[Route("/", handle_messages, methods=["POST"])]),
        ],
    )

    return starlette_app


def main():
    """Run the MCP server."""
    host = os.environ.get("MCP_HOST", "0.0.0.0")
    port = int(os.environ.get("MCP_PORT", "3002"))

    logger.info(f"Starting WAGO WebVisu MCP Server")
    logger.info(f"  URL: http://{host}:{port}/sse")
    logger.info(f"  Health: http://{host}:{port}/health")
    logger.info(f"  API Backend: {API_BASE_URL}")

    starlette_app = create_starlette_app()
    uvicorn.run(starlette_app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
