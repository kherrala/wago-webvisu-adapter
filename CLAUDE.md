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

npm run test:acceptance    # Run protocol acceptance tests against a live PLC (see docs/acceptance-tests.md)
npm run test:acceptance -- T05  # Run only tests whose name contains "T05"
npm run test:connection    # Test connectivity via Playwright browser, saves screenshots
npm run calibrate          # Interactive calibration tool (visible browser)

docker-compose up -d       # Start both containers
docker-compose up -d --build  # Rebuild and start
docker-compose logs -f     # View logs
```

There is no unit test suite or linter configured. Use `npm run test:acceptance` for integration testing against the live PLC.

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

## WebVisu UI Behavior (Given Truths)

These are verified, observed behaviors of the PLC's WebVisu interface. All UI control code must respect these as ground truth.

### Napit Tab Detection
- The Napit (light switches) tab has loaded successfully once **all** of these are painted:
  - Three lamp icons (status indicators)
  - Text labels: "Ohjaus", "Tallenna asetukset", "Lue asetukset", "1. painallus", "2. painallus"
- Wait for all draw commands to be received — forcing a redraw is not necessary

### Dropdown Behavior
- The dropdown takes **multiple render cycles** to open fully — wait for paint commands to arrive rather than forcing redraws
- A fully opened dropdown always redraws **5 dropdown selection item text labels** (with varying content depending on scroll position)
- Selecting a dropdown item always triggers a **redraw of the three lamp icons**
- All dropdown items and UI elements are within the visible viewport (no off-screen content)

### Dropdown Selection
- Once a dropdown item is selected, the **selected label is redrawn as the dropdown header**
- If the selection click misses the intended item, unintended consequences occur:
  - Elements below the dropdown may open a **dialog with an ESC button** to close
  - The **"Ohjaus" button** might be pressed accidentally
- These failure modes must be detected and recovered from

### Dropdown Scroll State
- On initial session load, the dropdown starts at the **top position** with the "0" item visible at the top
- The scrollbar is always at the top on initial load
- When the dropdown is **reused within the same session**, it retains its previously selected position
- Dragging is **always faster** than pressing arrow keys for navigation
- A successful drag always repaints **all 5 dropdown item text labels**

### Performance Considerations
- The PLC UI backend performance can vary; additional render cycles may be needed
- Forcing redraws is not necessary — waiting for all draw commands to be received is sufficient

## Acceptance Tests

`src/test-acceptance.ts` runs 11 test cases against a live PLC to validate the
full operation chain: connect → navigate → dropdown open → scroll → item click
→ header verification → status read.

Tests cover:
- Row 0 and row 4 selection (no scroll)
- Arrow-click forward scroll (small delta, ≤ 5)
- Drag forward scroll (large delta, > 5)
- Backward drag (always drag)
- `plcLabel` header verification (e.g. 'Essi Kattovalo', 'Onni Kattovalo')
- Large forward drag to near end of list (index 44)
- Sequential polling simulation (12 switches, exercises all scroll paths)

**Run locally before deploying changes to the protocol stack, config
coordinates, or scroll logic.** On failure the test saves a rendered UI PNG
snapshot to `data/acceptance-test-results/` and attempts to dismiss any
accidental keypad dialog before continuing. See `docs/acceptance-tests.md` for
failure-mode diagnostics.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROLLER` | `protocol` | Controller backend: `protocol` or `playwright` |
| `PORT` | `8080` | HTTP API port |
| `MCP_PORT` | `3002` | MCP SSE port |
| `HEADLESS` | `true` | Set to `false` for visible browser (Playwright only) |
| `DB_PATH` | `./data/lights.db` | SQLite database path |
| `PROTOCOL_SESSION_TRACE` | `false` | Enable protocol session trace logging (writes to `PROTOCOL_SESSION_TRACE_DIR`) |
| `POLLING_ENABLED` | `true` | Enable background polling |
| `POLL_INTERVAL_MS` | `2000` | Delay between individual light polls |
| `POLL_CYCLE_DELAY_MS` | `30000` | Delay between full polling cycles |
| `API_BASE_URL` | `http://localhost:8080` | Used by MCP server to reach the adapter |
| `PROTOCOL_HOST` | `192.168.1.10` | PLC hostname for protocol mode |
| `PROTOCOL_TIMEOUT` | `5000` | Request timeout for protocol mode (ms) |
