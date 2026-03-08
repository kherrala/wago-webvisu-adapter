# CLAUDE.md

## Project Overview

WAGO WebVisu Adapter — HTTP REST API and MCP server for controlling WAGO PLC home automation light switches via the CoDeSys binary protocol.

Two controller backends (selected via `CONTROLLER` env var):
1. **Protocol mode** (default) — Speaks CoDeSys binary protocol directly over HTTP POST. Lightweight, no browser.
2. **Playwright mode** (fallback) — Automates headless Chromium. Heavy but useful for debugging/calibration.

## Commands

```bash
npm run build              # Compile TypeScript
npm run dev                # Run protocol mode
npm run test:acceptance    # Integration tests against live PLC (run before deploying protocol changes)
npm run test:acceptance -- T05  # Run specific test
docker-compose up -d --build   # Deploy
```

**Important**: Always run individual tests (`npm run test:acceptance -- T05`) during development. Only run the full suite when explicitly asked — it takes a long time against the live PLC.

No unit tests or linter. `npm run test:acceptance` is the primary validation tool.

## Architecture

```
index.ts → controller (protocol or playwright) → Express API (port 8080)
                                                → background polling service
                                                → SQLite cache
mcp-server/server.py → MCP SSE proxy (port 3002) → HTTP API
```

Both controllers implement `IWebVisuController` (`controller-interface.ts`):
`initialize`, `close`, `selectLightSwitch`, `toggleLight`, `getLightStatus`, `getAllLights`, `navigateToTab`

### Key Files

| File | Purpose |
|------|---------|
| `protocol-controller.ts` | Protocol-based controller (main) |
| `protocol/client.ts` | Stateful protocol client: handshake, events, continuations, reconnection |
| `protocol/binary.ts` | MBUI, TLV, Frame binary primitives |
| `protocol/messages.ts` | Request builders and response parsers |
| `protocol/paint-commands.ts` | Paint command parser, status color extraction |
| `protocol/command-ids.ts` | CMD_* constants (single source of truth for command IDs) |
| `protocol/command-registry.ts` | All 107 paint command names for logging |
| `renderer/debug-renderer.ts` | Multi-layer pixel renderer: applies paint commands, composites layers, encodes PNG |
| `renderer/pixel-surface.ts` | RGBA pixel buffer with drawing primitives (fill, stroke, blit, clip) |
| `config.ts` | UI coordinates, light definitions (56 switches), timing, scroll params |
| `api.ts` | Express REST API |
| `database.ts` | SQLite with WAL mode |
| `polling-service.ts` | Background status polling |
| `webvisu-controller.ts` | Playwright fallback controller |

## Reverse Engineering Reference

The protocol implementation was reverse-engineered from the CoDeSys WebVisu JavaScript client. Reference materials in `reverse-engineering/`:

| File | Use |
|------|-----|
| `webvisu-deobfuscated.js` | **Primary reference** — formatted JS with ~350 renamed symbols. Always read this, never the minified original. |
| `PROTOCOL.md` | Binary protocol documentation (frames, TLV, handshake, service groups) |
| `PAINT-COMMANDS.md` | All 107 paint command types with data layouts and rendering behavior |
| `SYMBOL-REFERENCE.md` | Property/method name mappings for ambiguous short names (`.c`=Point.x, `.f`=Point.y, etc.) |
| `deobfuscate-transform.js` | jscodeshift AST transform with all symbol mappings |
| `deobfuscate.sh` | Regenerate `webvisu-deobfuscated.js` from `webvisu.js` |

**When working on the protocol stack**, consult `webvisu-deobfuscated.js` to understand how the original client handles specific scenarios. Search by class name (e.g., `MessageBuilder`, `ResponseParser`, `CanvasRenderer`) or by paint command name (e.g., `Fill3DRect`, `DrawText`, `SetFillColor`).

### Protocol Summary

- Transport: `POST /WebVisuV3.bin` with `application/octet-stream`
- Frame: 16-byte header (magic 0xCD55, service group/id, session id, content length)
- Payload: TLV-encoded with MBUI variable-length integers
- Handshake: OpenConnection → GetMyIP → DeviceSession → RegisterClient → IsRegistered → Viewport → Capabilities → StartVisu
- Events: mousedown/mouseup at canvas coordinates, packed as `(x << 16) | y` in param1
- Status detection: Parse SetFillColor/Fill3DRect near indicator coordinates; yellow (R>140, G>140) = ON

### Paint Command System

107 paint command types identified (see `PAINT-COMMANDS.md`). Our renderer implements ~30 of these:
- **Drawing**: DrawPrimitive (rect/ellipse/line, int/float variants), DrawPolygon (int16/float, fill/stroke/bezier), DrawText (latin1/UTF-16, legacy/new), Fill3DRect, DrawImage (with PLC image fetch + chroma key), DrawPixels
- **State**: SetFillColor, SetPenStyle, SetFont, SetAreaStyle, SetCornerRadius, SetCursorStyle, SetRenderParameter, SetCompositeMode
- **Clipping**: SetClipRect (push stack), RestoreClipRect (pop stack), ClearRect, ClearRectAndClip, ClearFullContext
- **Layers**: SelectLayer (ID 18/81) — switches active drawing surface (see Renderer section below)
- **Metadata**: InitVisualization, TouchHandlingFlags, TouchRectangles (parsed but no visual effect)

Unimplemented categories (not needed for light switch control): double-buffer/offscreen (IDs 54-57), UI element lifecycle (IDs 74-78), dialogs (IDs 88-91), text measurement (IDs 32-35, 50-53), transforms (ID 83), animations (IDs 90, 104), file transfer (IDs 67-69).

### Debug Renderer (Graphics Engine)

`src/renderer/` — Server-side pixel renderer that replays PLC paint commands into PNG frames. Used for acceptance test snapshots, status detection, and visual debugging.

**Architecture:**
```
PaintCommand[] → applyCommands() → PixelSurface(s) → renderCurrentSurface() → PNG
                     ↓                                        ↓
              state parsers (fill, pen, font, clip)    layer compositing
              shape parsers (primitive, polygon, 3D)   event stripe overlay
              text renderer (SVG via Resvg)            coordinate marker
              image loader (HTTPS fetch + decode)
```

**Multi-layer system** (matches CoDeSys reference):
- Base surface: opaque white background (layer ID -1)
- Layer surfaces: transparent background (alpha=0), created on demand
- `SelectLayer` (cmd 18/81) switches active drawing target by layer ID
- Compositing: base → highest layer ID → ... → layer 0 on top (foreground)
- ClearRect/ClearAll: white on base, transparent on layers
- PLC typically uses layer 1 (background fills) and layer 0 (UI content)

**Key files:**

| File | Purpose |
|------|---------|
| `renderer/debug-renderer.ts` | Main orchestrator: `applyCommands()`, layer management, frame persistence |
| `renderer/pixel-surface.ts` | RGBA pixel buffer: fillRect, strokeRect, drawLine, fillPolygon, fillEllipse, blitRgbaImage, clip support |
| `renderer/state-parsers.ts` | Parsers for SetFillColor, SetPenStyle, SetFont, SetAreaStyle, SetClipRect, SetCornerRadius, SelectLayer |
| `renderer/shape-commands.ts` | Parsers for DrawPrimitive (kinds 0-4), Fill3DRect, DrawPolygon, DrawPixels |
| `renderer/text-commands.ts` | TextRenderer: parses DrawText commands, renders via SVG/Resvg into pixel surface |
| `renderer/image-commands.ts` | ImageLoader: HTTPS image fetch from PLC, PNG/JPEG decode, SVG render, chroma key |
| `renderer/geometry.ts` | Rect parsing, clip rect intersection, coordinate normalization |
| `renderer/png-encoder.ts` | Raw RGBA → PNG encoding (zlib deflate, CRC32) |

**Two usage modes:**
1. **Disk mode**: `record(frame)` → writes PNG + JSON metadata + timeline to session directory
2. **No-disk mode**: `renderPreview(commands)` → returns PNG buffer directly (used by protocol controller for acceptance tests)

## Critical Design Details

- All operations go through `operationQueue` — serializes to prevent race conditions
- Dropdown scroll tracks position (`dropdownFirstVisible`) across calls; `dropdownStateUnknown` forces reset to top
- Light status: yellow (R>140, G>140) = ON, brown = OFF
- Dual-function switches use `firstPress`/`secondPress` via `?function=2` query param
- Canvas coordinates in `config.ts` are PLC-specific — recalibrate if UI changes

## WebVisu UI Behavior (Ground Truth)

- **Napit tab loaded** = three lamp icons + labels "Ohjaus", "Tallenna asetukset", "Lue asetukset", "1. painallus", "2. painallus" all painted
- **Dropdown open** = takes multiple render cycles; fully open when 5 item text labels are drawn
- **Item selected** = selected label redrawn as dropdown header + three lamp icons redrawn
- **Scroll state** = starts at top on new session; retained within session; drag faster than arrows
- **Misclick recovery** = may open keypad dialog (close with ESC) or press "Ohjaus" button
- Wait for draw commands — forcing redraws is not necessary

## Acceptance Tests

11 tests in `src/test-acceptance.ts`: connect → navigate → dropdown open → scroll → click → verify header → read status. Covers arrow scroll, drag scroll, backward drag, large jumps, sequential polling. Saves PNG snapshots on failure to `data/acceptance-test-results/`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROLLER` | `protocol` | Backend: `protocol` or `playwright` |
| `PORT` | `8080` | HTTP API port |
| `PROTOCOL_HOST` | `192.168.1.10` | PLC hostname |
| `PROTOCOL_TIMEOUT` | `5000` | Request timeout (ms) |
| `POLLING_ENABLED` | `true` | Background polling |
| `POLL_INTERVAL_MS` | `2000` | Delay between polls |
| `POLL_CYCLE_DELAY_MS` | `30000` | Delay between full cycles |
| `DB_PATH` | `./data/lights.db` | SQLite path |
| `PROTOCOL_SESSION_TRACE` | `false` | Protocol trace logging |
