# WAGO WebVisu Adapter

HTTP REST API adapter for WAGO PLC WebVisu home automation interfaces. This adapter uses headless browser automation to control canvas-based WebVisu interfaces and exposes functionality through a standard HTTP API and MCP server for Claude Desktop integration.

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
│  │   Playwright + Chromium          │    │   Tools:                     │  │
│  │   Browser automation             │    │   - list_lights              │  │
│  │                                  │    │   - get_light_status         │  │
│  └──────────────────────────────────┘    │   - toggle_light             │  │
│                 │                        └──────────────────────────────┘  │
│                 ▼                                      ▲                    │
│  ┌──────────────────────────────────┐                  │                    │
│  │       WAGO WebVisu (PLC)         │           Claude Desktop              │
│  │       Canvas-based UI            │                                       │
│  └──────────────────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

The solution consists of two containers:
- **wago-webvisu-adapter**: Node.js application with Playwright/Chromium for browser automation
- **mcp-server**: Lightweight Python MCP server that proxies requests to the HTTP API

## Prerequisites

- Docker and Docker Compose
- Network access to the WAGO PLC

For local development:
- Node.js 18+
- Python 3.12+

## Quick Start with Docker

1. Build and start:
```bash
docker-compose up -d
```

2. Check status:
```bash
docker-compose ps
docker-compose logs -f
```

4. Test the API:
```bash
curl http://localhost:8080/health
curl http://localhost:8080/api/lights
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP API server port |
| `MCP_PORT` | `3002` | MCP SSE server port |
| `HEADLESS` | `true` | Run browser in headless mode |

The WebVisu URL is configured in `src/config.ts`:

```typescript
url: 'https://192.168.1.10/webvisu/webvisu.htm'
```

## API Endpoints

### Health Check
```bash
curl http://localhost:8080/health
```

### List Available Lights
```bash
curl http://localhost:8080/api/lights
```

Response:
```json
{
  "count": 48,
  "lights": [
    {
      "id": "kylpyhuone-1",
      "name": "Kylpyhuone 1",
      "firstPress": "Kylpyhuone alakerta",
      "secondPress": null,
      "hasDualFunction": false,
      "href": "/api/lights/kylpyhuone-1"
    },
    {
      "id": "kylpyhuone-2",
      "name": "Kylpyhuone 2",
      "firstPress": "Sauna laude LED",
      "secondPress": "Sauna siivousvalo",
      "hasDualFunction": true,
      "href": "/api/lights/kylpyhuone-2"
    }
  ]
}
```

### Get Light Status
```bash
curl http://localhost:8080/api/lights/kylpyhuone-2
```

Response for a dual-function switch:
```json
{
  "id": "kylpyhuone-2",
  "name": "Kylpyhuone 2",
  "isOn": true,
  "isOn2": false,
  "firstPress": "Sauna laude LED",
  "secondPress": "Sauna siivousvalo",
  "hasDualFunction": true,
  "_links": {
    "self": "/api/lights/kylpyhuone-2",
    "toggle": "/api/lights/kylpyhuone-2/toggle",
    "toggleSecond": "/api/lights/kylpyhuone-2/toggle?function=2"
  }
}
```

### Toggle Light
```bash
# Toggle first function (default)
curl -X POST http://localhost:8080/api/lights/kylpyhuone-1/toggle

# Toggle second function (for dual-function switches)
curl -X POST http://localhost:8080/api/lights/kylpyhuone-2/toggle?function=2
```

### Debug: Take Screenshot
```bash
curl http://localhost:8080/api/debug/screenshot > screenshot.png
```

## Claude Desktop Integration (MCP)

The adapter includes an MCP (Model Context Protocol) server for integration with Claude Desktop.

### Setup

1. Start the containers:
```bash
docker-compose up -d
```

2. Add to Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "wago-webvisu": {
      "url": "http://localhost:3002/sse"
    }
  }
}
```

3. Restart Claude Desktop

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `list_lights` | List all available light switches with their functions (firstPress/secondPress) |
| `get_light_status` | Get status of a specific light (includes isOn2 for dual-function switches) |
| `toggle_light` | Toggle a light on/off. Supports `function` parameter (1 or 2) for dual-function switches |

### Dual-Function Switches

Some physical switches control two different lights:
- **First press** toggles the primary light (firstPress)
- **Second press** toggles the secondary light (secondPress)

The MCP tools expose this via the optional `function` parameter on `toggle_light`.

### Example Claude Prompts

- "List all the lights in my home"
- "Turn on the kitchen light"
- "What's the status of the bathroom lights?"
- "Toggle the hallway light"
- "Turn on the sauna cleaning light" (uses function=2 on kylpyhuone-2)
- "Which switches have dual functions?"

## Local Development

### Installation

```bash
# Install dependencies
npm install

# Install Playwright browser
npx playwright install chromium

# Build
npm run build
```

### Running Locally

```bash
# Development mode
npm run dev

# With visible browser (for debugging)
HEADLESS=false npm run dev

# Production
npm start
```

### MCP Server (Python)

```bash
cd mcp-server
pip install -r requirements.txt
API_BASE_URL=http://localhost:8080 python server.py
```

## Calibration

The UI coordinates in `src/config.ts` may need adjustment for your specific WebVisu setup.

### Interactive Calibration Tool

```bash
npx ts-node src/calibrate.ts
```

This opens a visible browser window. Click on UI elements to see their coordinates logged to the console.

### Connection Test Tool

```bash
npm run test:connection
```

Takes screenshots at each step and saves them to `calibration-screenshots/` for verification.

### Updating Coordinates

Edit `src/config.ts` to update the coordinate mappings:

```typescript
export const uiCoordinates = {
  tabs: {
    napit: { x: 490, y: 11 },
    // ...
  },
  lightSwitches: {
    dropdown: { x: 280, y: 130 },
    dropdownArrow: { x: 523, y: 139 },
    ohjausButton: { x: 280, y: 159 },      // First function button
    ohjausButton2: { x: 290, y: 240 },     // Second function button
    statusIndicator: { x: 505, y: 204 },   // First status indicator
    statusIndicator2: { x: 505, y: 274 },  // Second status indicator
    // ...
  },
};
```

## Project Structure

```
wago-webvisu-adapter/
├── src/
│   ├── config.ts              # Configuration and UI coordinates
│   ├── webvisu-controller.ts  # Playwright browser automation
│   ├── api.ts                 # Express HTTP API
│   ├── index.ts               # Main entry point
│   ├── test-connection.ts     # Connection test utility
│   └── calibrate.ts           # Interactive calibration tool
├── mcp-server/
│   ├── server.py              # Python MCP server
│   ├── requirements.txt       # Python dependencies
│   └── Dockerfile             # MCP server container
├── Dockerfile                 # Main adapter container
├── docker-compose.yml         # Container orchestration
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### Timeout on Startup

If the adapter times out during initialization:

1. **Test network connectivity:**
   ```bash
   curl -k https://192.168.1.10/webvisu/webvisu.htm
   ```

2. **Run with visible browser:**
   ```bash
   HEADLESS=false npm run dev
   ```

3. **Check the debug screenshot** saved as `debug-no-canvas.png` if canvas is not found.

### MCP Server Connection Issues

1. **Check both containers are running:**
   ```bash
   docker-compose ps
   ```

2. **Check MCP server health:**
   ```bash
   curl http://localhost:3002/health
   ```

3. **Check logs:**
   ```bash
   docker-compose logs mcp-server
   ```

### Operations Not Working

Canvas-based UIs require precise coordinates. If clicks don't work:

1. Run the calibration tool to verify coordinates
2. Compare calibration screenshots with expected behavior
3. Adjust coordinates in `src/config.ts`

## Docker Commands

```bash
# Build images
docker-compose build

# Start containers
docker-compose up -d

# Stop containers
docker-compose down

# View logs
docker-compose logs -f

# View specific container logs
docker-compose logs -f wago-webvisu-adapter
docker-compose logs -f mcp-server

# Rebuild and restart
docker-compose up -d --build
```

## License

MIT
