# WAGO WebVisu Adapter

HTTP REST API and MCP server for controlling WAGO PLC home automation light switches. The adapter speaks the CoDeSys binary protocol directly over HTTP — no browser required.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Docker Compose                                     │
│                                                                              │
│  ┌──────────────────────────────────┐    ┌──────────────────────────────┐  │
│  │      wago-webvisu-adapter        │    │         mcp-server           │  │
│  │         (Node.js)                │    │          (Python)            │  │
│  │                                  │    │                              │  │
│  │   HTTP REST API (Express)        │◄───│   MCP SSE Server             │  │
│  │   Port 8080                      │    │   Port 3002                  │  │
│  │                                  │    │                              │  │
│  │   Protocol controller (default)  │    │   Tools:                     │  │
│  │   CoDeSys binary over HTTP       │    │   - list_lights              │  │
│  │                                  │    │   - get_light_status         │  │
│  │   SQLite cache + polling service │    │   - toggle_light             │  │
│  └──────────────────────────────────┘    └──────────────────────────────┘  │
│                 │                                      ▲                    │
│                 ▼                                      │                    │
│  ┌──────────────────────────────────┐           Claude Desktop              │
│  │       WAGO PLC (WebVisuV3)       │                                       │
│  │       CoDeSys runtime            │                                       │
│  └──────────────────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

Two containers:
- **wago-webvisu-adapter**: Node.js app with Express API, protocol controller, SQLite status cache, and background polling service
- **mcp-server**: Lightweight Python MCP server that proxies requests to the HTTP API

### Controller modes

| Mode | Default | Description |
|------|---------|-------------|
| `protocol` | ✓ | Speaks CoDeSys binary protocol directly. Lightweight, no browser. |
| `playwright` | | Automates a headless Chromium browser. Useful for calibration. |

## Prerequisites

- Docker and Docker Compose
- Network access to the WAGO PLC

For local development:
- Node.js 18+
- Python 3.12+

## Quick Start

```bash
# Build and start
docker compose up -d

# Check status
docker compose ps
docker compose logs -f

# Test the API
curl http://localhost:8080/health
curl http://localhost:8080/api/lights
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROLLER` | `protocol` | Controller backend: `protocol` or `playwright` |
| `PORT` | `8080` | HTTP API server port |
| `MCP_PORT` | `3002` | MCP SSE server port |
| `DB_PATH` | `./data/lights.db` | SQLite database path |
| `POLLING_ENABLED` | `true` | Enable background light status polling |
| `POLL_CYCLE_DELAY_MS` | `30000` | Delay between full polling cycles (ms) |
| `PROTOCOL_HOST` | `192.168.1.10` | PLC hostname |
| `PROTOCOL_PORT` | `443` | PLC HTTPS port |
| `PROTOCOL_TIMEOUT` | `5000` | Per-request timeout (ms) |
| `HEADLESS` | `true` | Headless browser (Playwright mode only) |
| `PROTOCOL_DEBUG_HTTP` | `false` | Verbose protocol HTTP frame logs |
| `PROTOCOL_SESSION_TRACE` | `true` | Write per-session protocol frames to trace files |
| `PROTOCOL_SESSION_TRACE_DIR` | `/data/protocol-trace` | Directory for session trace files |
| `PROTOCOL_LOG_RAW_FRAME_DATA` | `false` | Include raw frame bytes in logs |
| `PROTOCOL_DEBUG_RENDER` | `false` | Render paint commands into PNG debug frames |
| `PROTOCOL_DEBUG_RENDER_DIR` | `/data/protocol-render-debug` | Base directory for rendered frame sessions |
| `PROTOCOL_DEBUG_RENDER_MAX_FRAMES` | `400` | Maximum rendered frames per session |
| `PROTOCOL_DEBUG_RENDER_MIN_INTERVAL_MS` | `0` | Minimum interval between frames (0 = capture all) |
| `PROTOCOL_DEBUG_RENDER_INCLUDE_EMPTY` | `true` | Persist empty paint responses (useful for timing gaps) |
| `PROTOCOL_DEBUG_RENDER_FETCH_IMAGES` | `true` | Fetch image assets from PLC image pool |
| `PROTOCOL_DEBUG_RENDER_IMAGE_FETCH_TIMEOUT_MS` | `1200` | Timeout per image fetch (ms) |

The PLC address is set in `src/config.ts` and environment variables above.

## API Endpoints

### Health Check
```bash
curl http://localhost:8080/health
```
```json
{"status": "healthy", "webvisuConnected": true}
```

### List Physical Lights
```bash
curl http://localhost:8080/api/lights
```
```json
{
  "count": 47,
  "lights": [
    {
      "id": "kylpyhuone",
      "name": "Kylpyhuone",
      "hasDualFunction": false,
      "controllers": [
        {"switchId": "kylpyhuone-1", "switchName": "Kylpyhuone 1", "functionNumber": 1}
      ],
      "isOn": true,
      "isOn2": null,
      "polledAt": "2025-01-15T10:23:00.000Z",
      "href": "/api/lights/kylpyhuone"
    },
    {
      "id": "sauna-laude-ledi",
      "name": "Saunan laude ledi",
      "hasDualFunction": true,
      "controllers": [
        {"switchId": "kylpyhuone-2", "switchName": "Kylpyhuone 2", "functionNumber": 1},
      ],
      "isOn": false,
      "isOn2": null,
      "polledAt": "2025-01-15T10:23:05.000Z",
      "href": "/api/lights/sauna-laude-ledi"
    }
  ]
}
```

`isOn` and `isOn2` are `null` until the background poller has queried the light at least once. `hasDualFunction` means the light is also reachable via a second-press function on at least one of its switches.

### Get Light Status (live)
```bash
curl http://localhost:8080/api/lights/kylpyhuone
```
```json
{
  "id": "kylpyhuone",
  "name": "Kylpyhuone",
  "isOn": true,
  "hasDualFunction": false,
  "controllers": [
    {"switchId": "kylpyhuone-1", "switchName": "Kylpyhuone 1", "functionNumber": 1}
  ],
  "_links": {
    "self": "/api/lights/kylpyhuone",
    "toggle": "/api/lights/kylpyhuone/toggle"
  }
}
```

### Toggle Light
```bash
curl -X POST http://localhost:8080/api/lights/kylpyhuone/toggle
```
The adapter uses the light's primary controller (configured in `src/config.ts`) to determine which switch and function to activate.

### Polling Status
```bash
curl http://localhost:8080/api/polling/status
```

### Debug: Rendered UI Image
```bash
curl http://localhost:8080/api/debug/rendered-ui > rendered-ui.png
```
Returns the latest cumulative rendered frame cached in memory (requires `PROTOCOL_DEBUG_RENDER=true`). Does not trigger a new render.

Debug frames are saved automatically into timestamped session folders:
```
./data/protocol-render-debug/session-YYYYMMDD-HHMMSS-MMM/
  frame-....png   — rendered approximation of the UI
  frame-....json  — timing + request/response metadata
  timeline.ndjson — append-only timeline for sequence analysis
```

The renderer fetches real image assets from the PLC image pool (`/ImageByImagePoolId` + `application.imagepoolcollection.csv`) so DrawImage commands are painted accurately.

### Debug: Navigate to Tab
```bash
curl -X POST http://localhost:8080/api/debug/navigate/napit
```
Valid tabs: `autokatos`, `ulkopistorasia`, `lisatoiminnot`, `napit`, `lammitys`, `hvac`.

## Claude Desktop Integration (MCP)

### Setup

1. Start the containers:
```bash
docker compose up -d
```

2. Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):
```json
{
  "mcpServers": {
    "wago-webvisu": {
      "url": "http://localhost:3002/sse"
    }
  }
}
```

3. Restart Claude Desktop.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `list_lights` | List all physical lights with cached on/off status and controlling switches |
| `get_light_status` | Get live status of a specific light by ID |
| `toggle_light` | Toggle a light on or off by ID |

### Example Prompts

- "List all the lights in my home"
- "Turn on the kitchen light"
- "What's the status of the bathroom lights?"
- "Toggle the hallway light"
- "Which lights are currently on?"

## Local Development

### Installation

```bash
npm install
npm run build
```

For Playwright mode only:
```bash
npx playwright install chromium
```

### Running Locally

```bash
# Protocol mode (default)
npm run dev

# Playwright mode with visible browser
CONTROLLER=playwright HEADLESS=false npm run dev

# Production
npm start
```

### MCP Server (Python)

```bash
cd mcp-server
pip install -r requirements.txt
API_BASE_URL=http://localhost:8080 python server.py
```

## Project Structure

```
wago-webvisu-adapter/
├── src/
│   ├── config.ts                # Light catalog, switch catalog, UI coordinates
│   ├── controller-interface.ts  # Shared IWebVisuController interface
│   ├── protocol-controller.ts   # CoDeSys binary protocol controller (default)
│   ├── webvisu-controller.ts    # Playwright browser controller (fallback)
│   ├── api.ts                   # Express HTTP API
│   ├── polling-service.ts       # Background light status poller
│   ├── database.ts              # SQLite status cache
│   ├── index.ts                 # Main entry point
│   └── protocol/
│       ├── binary.ts            # MBUI/TLV/Frame binary primitives
│       ├── messages.ts          # Request builders + response parsers
│       ├── paint-commands.ts    # Paint command parser, status color extraction
│       └── client.ts            # Stateful protocol HTTP client
├── mcp-server/
│   ├── server.py                # Python MCP server
│   ├── requirements.txt
│   └── Dockerfile
├── data/                        # SQLite DB + protocol traces (bind-mounted)
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── README.md
```

### Light and Switch Model

Lights are the canonical resource: each has a unique `id` and `name`. One or more physical switches (or first/second-press functions on a switch) may control the same light.

- **`lightList`** — physical light catalog (47 lights)
- **`lightSwitchList`** — PLC dropdown switches (57 entries, 0-indexed), each with optional `firstPressLightId` and `secondPressLightId`
- **`lightPrimaryController`** — maps each light ID to its preferred `{switchId, functionNumber}` for status queries and toggles (first-press preferred over second-press)
- **`lightAllControllers`** — all controller pairs per light

Status is cached by light ID so a query via one switch populates the cache for all other switches controlling the same light.

## Troubleshooting

### Adapter not connecting to PLC

```bash
# Test network access
curl -k https://192.168.1.10/WebVisuV3.bin

# Check adapter logs
docker compose logs -f wago-webvisu-adapter
```

### MCP server connection issues

```bash
# Check both containers
docker compose ps

# Check MCP health
curl http://localhost:3002/health

# Check logs
docker compose logs mcp-server
```

### Diagnosing protocol issues

Enable debug render to capture paint commands as PNG frames:

```bash
PROTOCOL_DEBUG_RENDER=true docker compose up -d
curl http://localhost:8080/api/debug/rendered-ui > rendered-ui.png
```

Session traces (raw frames) are written to `./data/protocol-trace/` by default.

## Docker Commands

```bash
docker compose build          # Build images
docker compose up -d          # Start containers
docker compose up -d --build  # Rebuild and start
docker compose down           # Stop containers
docker compose logs -f        # View all logs
docker compose logs -f wago-webvisu-adapter
docker compose logs -f mcp-server
```

## License

MIT
