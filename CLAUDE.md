# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WAGO WebVisu Adapter — HTTP REST API and MCP server for controlling WAGO PLC home automation light switches. Supports two controller backends:

1. **Protocol mode** (default) — Speaks the CoDeSys binary protocol directly over HTTP POST, eliminating the browser entirely. Lightweight, fast, no Chromium dependency.
2. **Playwright mode** (fallback) — Automates a headless Chromium browser via Playwright, clicking canvas coordinates and reading pixel colors. Heavy (2GB SHM), slower, but useful for debugging/calibration.

## Build & Run Commands

```bash
npm run build          # Compile TypeScript (tsc)
npm run dev            # Run with ts-node (protocol mode, default)
CONTROLLER=playwright npm run dev  # Run with Playwright browser controller
CONTROLLER=playwright HEADLESS=false npm run dev  # Playwright with visible browser
npm start              # Run compiled dist/index.js

npm run test:connection    # Test connectivity to WAGO PLC, saves screenshots
npm run calibrate          # Interactive calibration tool (visible browser)

docker-compose up -d       # Start both containers
docker-compose up -d --build  # Rebuild and start
docker-compose logs -f     # View logs
```

There is no test suite or linter configured.

## Architecture

Two Docker containers orchestrated via docker-compose:

1. **wago-webvisu-adapter (Node.js/TypeScript, port 8080)** — Express HTTP API + controller (protocol or Playwright) + SQLite cache + background polling service
2. **mcp-server (Python, port 3002)** — MCP SSE server that proxies requests to the HTTP API for Claude Desktop integration

### Core Flow

`index.ts` → selects controller based on `CONTROLLER` env var → initializes database → connects to PLC → navigates to "Napit" (light switches) tab → starts Express API → starts background polling

### Controller Interface

Both controllers implement `IWebVisuController` (defined in `controller-interface.ts`):
- `initialize()` / `close()` — lifecycle
- `selectLightSwitch(id)` / `toggleLight(id, fn)` / `getLightStatus(id)` / `getAllLights()` — light operations
- `navigateToTab(name)` — tab navigation
- `takeScreenshot()` — screenshot (empty buffer in protocol mode)
- Operation queue serialization, dropdown scroll tracking

### Key Modules

- **`controller-interface.ts`** — Shared `IWebVisuController` interface and `LightStatus` type
- **`protocol-controller.ts`** — Protocol-based controller. Uses `protocol/client.ts` to speak CoDeSys binary protocol directly.
- **`protocol/binary.ts`** — MBUI, TLV, Frame binary primitives for the CoDeSys wire format
- **`protocol/messages.ts`** — Request builders and response parsers (OpenConnection, RegisterClient, GetPaintData, events)
- **`protocol/paint-commands.ts`** — Paint command parser, status color extraction from Fill3DRect/SetFillColor commands
- **`protocol/client.ts`** — Stateful protocol client managing handshake, events, continuations, reconnection
- **`webvisu-controller.ts`** — Playwright-based controller (fallback). Manages Chromium lifecycle, canvas clicks, pixel-color status detection.
- **`config.ts`** — All hardcoded UI coordinates, light switch definitions (56 switches, 48 functional), timing delays, dropdown scroll parameters, protocol config.
- **`api.ts`** — Express REST API with endpoints for light listing, status queries, toggling, and debug tools.
- **`database.ts`** — SQLite (better-sqlite3) with WAL mode. Tables: `light_status` (cached status), `polling_metadata` (last poll index).
- **`polling-service.ts`** — Background service that cycles through all lights to keep cached status fresh.
- **`mcp-server/server.py`** — Python ASGI app (uvicorn) exposing 3 MCP tools: `list_lights`, `get_light_status`, `toggle_light`.

### Protocol Details

The CoDeSys binary protocol is documented in `data/reverse-engineering/PROTOCOL.md`. Key points:
- Transport: `POST /WebVisuV3.bin` with `application/octet-stream` body
- Frame: 16-byte header (magic 0xCD55, service group/id, session id, content length)
- Payload: TLV-encoded with MBUI variable-length integers
- Handshake: OpenConnection → GetMyIP → DeviceSession → RegisterClient → IsRegisteredClient → Viewport → Capabilities → StartVisu
- Events: mousedown/mouseup at canvas coordinates (same coordinate system as Playwright mode)
- Status detection: Parse paint command responses for SetFillColor/Fill3DRect near status indicator coordinates; yellow (R>140, G>140) = ON

### Critical Design Details

- All interactions go through the controller's `operationQueue` — serializes operations to prevent race conditions
- Dropdown navigation tracks scroll position (`dropdownFirstVisible`) across calls to minimize scrolling; `dropdownStateUnknown` flag forces reset to top
- Light status detection: yellow (R>140, G>140) = ON, brown = OFF — same thresholds in both controllers
- Dual-function switches have `firstPress`/`secondPress` — toggled via `?function=2` query parameter
- The canvas coordinates in `config.ts` are specific to the target PLC's WebVisu layout and must be recalibrated if the UI changes

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROLLER` | `protocol` | Controller backend: `protocol` or `playwright` |
| `PORT` | `8080` | HTTP API port |
| `MCP_PORT` | `3002` | MCP SSE port |
| `HEADLESS` | `true` | Set to `false` for visible browser (Playwright only) |
| `DB_PATH` | `./data/lights.db` | SQLite database path |
| `POLLING_ENABLED` | `true` | Enable background polling |
| `POLL_INTERVAL_MS` | `2000` | Delay between individual light polls |
| `POLL_CYCLE_DELAY_MS` | `30000` | Delay between full polling cycles |
| `API_BASE_URL` | `http://localhost:8080` | Used by MCP server to reach the adapter |
| `PROTOCOL_HOST` | `192.168.1.10` | PLC hostname for protocol mode |
| `PROTOCOL_TIMEOUT` | `5000` | Request timeout for protocol mode (ms) |
