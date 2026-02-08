# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WAGO WebVisu Adapter — HTTP REST API and MCP server for controlling WAGO PLC home automation light switches via headless browser automation (Playwright/Chromium). The adapter interacts with a canvas-based WebVisu UI by clicking precise pixel coordinates and reading pixel colors to detect light status.

## Build & Run Commands

```bash
npm run build          # Compile TypeScript (tsc)
npm run dev            # Run with ts-node (development)
npm start              # Run compiled dist/index.js
HEADLESS=false npm run dev  # Run with visible browser for debugging

npm run test:connection    # Test connectivity to WAGO PLC, saves screenshots
npm run calibrate          # Interactive calibration tool (visible browser)

docker-compose up -d       # Start both containers
docker-compose up -d --build  # Rebuild and start
docker-compose logs -f     # View logs
```

There is no test suite or linter configured.

## Architecture

Two Docker containers orchestrated via docker-compose:

1. **wago-webvisu-adapter (Node.js/TypeScript, port 8080)** — Express HTTP API + Playwright browser automation + SQLite cache + background polling service
2. **mcp-server (Python, port 3002)** — MCP SSE server that proxies requests to the HTTP API for Claude Desktop integration

### Core Flow

`index.ts` → initializes database → launches Chromium → navigates to "Napit" (light switches) tab → starts Express API → starts background polling

### Key Modules

- **`webvisu-controller.ts`** — Central component. Singleton `WebVisuController` class manages Chromium lifecycle, canvas coordinate clicks, dropdown scrollbar navigation, pixel-color status detection (yellow = ON, brown = OFF), and an operation queue that serializes all browser interactions to prevent race conditions.
- **`config.ts`** — All hardcoded UI coordinates, light switch definitions (56 switches, 48 functional), timing delays, and dropdown scroll parameters. The WebVisu URL (`https://192.168.1.10/webvisu/webvisu.htm`) is configured here.
- **`api.ts`** — Express REST API with endpoints for light listing, status queries, toggling, and debug tools (screenshots, canvas info).
- **`database.ts`** — SQLite (better-sqlite3) with WAL mode. Tables: `light_status` (cached status), `polling_metadata` (last poll index).
- **`polling-service.ts`** — Background service that cycles through all lights to keep cached status fresh. Configurable cycle delay (default 30s).
- **`mcp-server/server.py`** — Python ASGI app (uvicorn) exposing 3 MCP tools: `list_lights`, `get_light_status`, `toggle_light`.

### Critical Design Details

- All browser interactions go through `WebVisuController.operationQueue` — never make direct Playwright calls outside this queue
- Dropdown navigation tracks scroll position (`dropdownFirstVisible`) across calls to minimize scrolling; `dropdownStateUnknown` flag forces reset to top
- Light status is detected by reading canvas pixel RGB values at specific coordinates — thresholds are in `webvisu-controller.ts`
- Dual-function switches have `firstPress`/`secondPress` — toggled via `?function=2` query parameter
- The canvas element coordinates in `config.ts` are specific to the target PLC's WebVisu layout and must be recalibrated if the UI changes

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP API port |
| `MCP_PORT` | `3002` | MCP SSE port |
| `HEADLESS` | `true` | Set to `false` for visible browser |
| `DB_PATH` | `./data/lights.db` | SQLite database path |
| `POLLING_ENABLED` | `true` | Enable background polling |
| `POLL_INTERVAL_MS` | `2000` | Delay between individual light polls |
| `POLL_CYCLE_DELAY_MS` | `30000` | Delay between full polling cycles |
| `API_BASE_URL` | `http://localhost:8080` | Used by MCP server to reach the adapter |
