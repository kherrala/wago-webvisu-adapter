# CoDeSys 3 WebVisu Binary Protocol

Reverse-engineered from `webvisu.js` (CAS 1.0.0 / CoDeSys WebVisu client v3.5.17.0) served by WAGO PLC (Runtime 3.5.16.3).

## Transport

- **Endpoint:** `POST /WebVisuV3.bin` over HTTPS (self-signed certificate)
- **Content-Type:** `application/octet-stream`
- **Request/Response:** Binary `ArrayBuffer`
- **Polling model:** Client polls server at configurable interval (default 200ms). No WebSockets or server-push.
- **Idle optimization:** Polling speeds up to ~40ms during active user interaction (UpdateRate/5), slows back to 200ms when idle.

## Configuration

Loaded via `GET /webvisu/webvisu.cfg.json` before any binary communication:

```json
{
  "UpdateRate": 200,
  "PlcAddress": "0370.1000.2DDC.C0A8.010A",
  "UseLocalHost": true,
  "Application": "Application",
  "StartVisu": "Visualization",
  "BestFit": false,
  "LogLevel": "INFO",
  "CommBufferSize": 50000,
  "HasKeyboard": false,
  "TouchHandlingActive": false,
  "HandleTouchEvents": false,
  "ScaleTypeIsotropic": false,
  "BestFitForDialogs": false,
  "RuntimeVersion": "3.5.16.3"
}
```

## Frame Format

Every request and response is wrapped in a fixed header:

```
Offset  Size(B)  Type     Field           Notes
0       2        Uint16   Magic           Always 0xCD55 (52565)
2       2        Uint16   HeaderLength    Always 16
4       2        Uint16   ServiceGroup    Request: group | Response: 0x80 | group
6       2        Uint16   ServiceID       Operation within the group
8       4        Uint32   SessionID       From OpenConnection handshake
12      4        Uint32   ContentLength   Payload byte count after header
14      2        Uint16   Reserved        0
```

Total header: **16 bytes**, followed by `ContentLength` bytes of TLV-encoded payload.

All multi-byte integers are **little-endian** (Intel byte order) as negotiated during OpenConnection.

### Response Validation

Response frames have `ServiceGroup = 0x80 | requestServiceGroup`. For example, a request to group 4, ID 4 returns group 0x84, ID 4.

## TLV (Tag-Length-Value) Encoding

Payload data uses nested TLV structures. Both tags and lengths are encoded as **MBUI** (Multi-Byte Unsigned Integer):

```
MBUI encoding:
  - Each byte contributes 7 data bits (bits 0-6)
  - Bit 7 = continuation flag (1 = more bytes follow, 0 = last byte)
  - Bytes are little-endian ordered

Examples:
  Value 0-127:     1 byte   (value & 0x7F)
  Value 128-16383: 2 bytes  (value & 0x7F | 0x80), ((value >> 7) & 0x7F)
  etc.
```

**Reading MBUI:**
```
value = 0, shift = 0
do:
    byte = readUint8()
    value |= (byte & 0x7F) << shift
    shift += 7
while (byte & 0x80)
```

**Writing MBUI** with a known number of bytes:
```
for i = 0 to numBytes-2:
    writeByte(value & 0x7F | 0x80)  // set continuation bit
    value >>= 7
writeByte(value & 0x7F)             // final byte, no continuation
```

The writer pre-determines the number of bytes needed:
- 1 byte for values 0-127
- 2 bytes for values 128-16383
- 3 bytes for values 128-2097151
- Use 3 bytes (length code `3`) or 6 bytes for larger values

## Service Groups & Operations

| Group | ID | Name | Direction | Purpose |
|-------|----|------|-----------|---------|
| 1 | 1 | OpenConnection | req/resp | Establish session (text-based response) |
| 1 | 2 | DeviceSession (old) | req/resp | Create device session, get DeviceSessionId |
| 1 | 10 | DeviceSession (new) | req/resp | New-style session with CAS factory |
| 1 | 100 | Benchmark | req/resp | Dummy request for POST method benchmarking |
| 3 | — | GetMyIP | req/resp | Retrieve client IP address |
| **4** | **1** | **RegisterClient** | **req/resp** | **Register visualization client, get externId** |
| 4 | 2 | RemoveClient | req/resp | Unregister client by externId |
| **4** | **3** | **IsRegisteredClient** | **req/resp** | **Poll until registration is confirmed** |
| **4** | **4** | **GetPaintData** | **req/resp** | **Main data exchange: send events, receive paint commands** |
| 4 | 6 | GetPaintData (ext) | req/resp | Extended paint data variant |
| 8 | 1-9 | FileTransfer | req/resp | File upload/download to/from PLC |

## Connection Startup Sequence

### Step 1: Load Configuration
```
GET /webvisu/webvisu.cfg.json
```
Parse JSON response into Configuration object.

### Step 2: Load Image Pool (optional)
```
GET /webvisu/application.imagepoolcollection.csv
```
CSV mapping of image names to paths. Not needed for headless operation.

### Step 3: OpenConnection (Group 1, ID 1)

**Request payload** (text, pipe-delimited):
```
\x01\x00\x00\x00    (preamble: version=1, padding)
|PlcAddress|CommBufferSize|UseLocalHost|
```

Specifically for this PLC:
```
|0370.1000.2DDC.C0A8.010A|50000|1|
```

The request message builder (`$q` method):
1. Writes MBUI tag `1` (service type marker)
2. Writes the pipe-delimited string as ISO-8859-1 bytes

**Response** (text, pipe-delimited, inside binary frame):
```
|CommBufferSize|IntelByteOrder|SessionId|DemoMode|SupportsPostMethod|
```

- `CommBufferSize`: int (e.g., `50000`)
- `IntelByteOrder`: `0` = little-endian (Intel), `1` = big-endian
- `SessionId`: int (used in all subsequent frame headers)
- `DemoMode`: `true`/`false`
- `SupportsPostMethod`: `true`/`false`

### Step 4: GetMyIP (Group 3)

Sends empty request. Response contains client IP as text `IPv4:x.x.x.x`.

### Step 5: DeviceSession (Group 1, ID 2)

Creates device session. Request contains:
- TLV tag 34: `Uint32` session type (e.g., `D.A = 0`)
- TLV tag 37: `Uint32` crypt type

Response contains DeviceSessionId and error codes. If authentication is required, returns a crypt challenge.

For our PLC (no auth configured), this step succeeds immediately with DeviceSessionId.

### Step 6: RegisterClient (Group 4, ID 1)

**Request payload TLVs:**
- Tag 1: Application name string (null-terminated) + padding + `Uint32` flags (524288 = 0x80000)
- Optional: client name (tag type 1) and IP string (tag type 2) as 84-byte fixed records

**Response:** `Uint32` externId (client ID used in all subsequent events). Error values:
- `>= 0xB0000000`: error
- `0xFFFFFFFA`: "Visualization is not allowed"
- `0xFFFFFFFC`: "No more memory on the plc"
- `0xFFFFFFFD`: "Connection to invalid application"
- `0xFFFFFFF9`: "Too many clients"

### Step 7: IsRegisteredClient (Group 4, ID 3)

**Request:** TLV tag 3 with `Uint32` externId.

**Response:** `Uint32` status:
- `0`: Registered successfully
- `1`: Still pending (keep polling at 100ms)
- `2`: Registration failed
- `3`: Invalid external id

### Step 8: Init Paint Request 1 — Viewport (Group 4, ID 4)

Sends event tag `516` with:
- `param1 = viewportFlags` (bitmask from BestFit/BestFitForDialogs/ScaleTypeIsotropic)
- `param2 = 0`
- extra data:
```
Int16:  0         (viewport X)
Int16:  0         (viewport Y)
Int16:  1279      (width - 1)
Int16:  1023      (height - 1)
Float32: 1.0      (device pixel ratio)
```

### Step 9: Init Paint Request 2 — Capabilities (Group 4, ID 4)

Sends event tag `1048576` (0x100000) with extra data:
```
Uint32: 458752    (protocol version 0x70000)
Uint32: 7         (supported features bitmask)
Uint32: flags     (keyboard bits 3-4, touch bits 0-1)
```

For our config (no keyboard, no touch): flags = `0`.

### Step 10: Init Paint Request 3 — StartVisu (Group 4, ID 4)

Sends event tag `1048576` (0x100000) with extra data:
```
Uint32: 1         (start command)
String: "Visualization\0"  (null-terminated)
```

### Step 11: Main Polling Loop

Cyclic GetPaintData requests. Each cycle either:
- Sends a queued user event (mouse click, key press), or
- Sends a heartbeat: event tag `1`, clientId, x=0, y=0

## Event Message Format (GetPaintData Request)

Events are sent inside GetPaintData (group 4, id 4). The request wraps the event in TLV tag 132:

### Event TLV Structure (inside tag 132)

```
Tag 1 (16 bytes):
  Uint32: eventTag
  Uint32: param1
  Uint32: param2
  Uint32: clientId (externId)

[Optional] Tag 2: extra data buffer
  If scale info present: Uint32 scaleKb, Uint32 scaleZb
  Then: raw extra data bytes

[Optional] Tag 3 (8 bytes): clipping rectangle
  Uint16: left
  Uint16: top
  Uint16: right
  Uint16: bottom

[Optional] Tag 5 (8 bytes): scale info
  Uint32: kb
  Uint32: zb
```

### Event Tags

| Tag | Name | param1 | param2 |
|-----|------|--------|--------|
| 1 | Heartbeat | 0 | 0 |
| 2 | MouseDown | packedPoint(X,Y) | 0 |
| 4 | MouseUp | packedPoint(X,Y) | 0 |
| 16 | MouseMove | packedPoint(X,Y) | 0 |
| 128 | KeyDown | keyCode | modifierFlags |
| 256 | KeyUp | keyCode | modifierFlags |
| 257 | KeyPress | charCode | 0 |
| 516 | ViewportInfo | viewportFlags | 0 |
| 1048576 | Control | sub-command | 0 |
| 4096 | MouseOut | — | — |

**Modifier flags for keyboard events:** shift=1, alt=2, ctrl=4 (bitwise OR).

`packedPoint(X,Y)` is encoded exactly like `webvisu.js` `w.Yc()`:
- high 16 bits = X
- low 16 bits = Y
- both truncated to unsigned 16-bit.

**Coordinate system:** Canvas pixel coordinates, origin at top-left. For a 1280x1024 viewport, X ranges 0-1279, Y ranges 0-1023.

### How to Click a Button

To simulate a button click at coordinates (x, y):

1. Send GetPaintData with mousedown event (tag=2, x, y, clientId)
2. Wait for response (parse paint commands)
3. Send GetPaintData with mouseup event (tag=4, x, y, clientId)
4. Wait for response (parse paint commands with updated state)

## Paint Data Response Format

Response to GetPaintData (group 0x84, id 4):

### Top-level TLVs

- **Tag 132** (or 129 for new-style): Container for paint data
  - **Tag 1**: `Uint32` error code
    - `0`: Success
    - `65535`: "Client id not present or no longer valid"
  - **Tag 2**: Paint header
    - `Uint32`: unused
    - `Uint32`: command count
    - `Uint32`: total data size
    - `Uint32`: continuation token (0 = complete, >0 = more data follows)
  - **Tag 3**: Raw paint command data
  - **Tag 4**: Finish marker (0 continuation remaining)
- **Tag 34**: `Uint32` session info

### Paint Commands

The raw data in Tag 3 is a sequence of paint commands:
```
For each command:
  Uint32: commandSize (total bytes including this field)
  Uint32: commandId (index into command table)
  Bytes:  command-specific data (commandSize - 8 bytes)
```

There are 100+ paint command types. Key ones for light status detection:

| ID | Name | Description |
|----|------|-------------|
| 0 | Noop | No operation |
| 4 | SetFillColor | Sets fill color (ARGB uint32) |
| 5 | SetPenStyle | Line style, color, width |
| 6 | SetFont | Font color, size, name |
| 7 | ClearRect | Clear/fill rectangle area |
| 19 | DrawImage | Image with position and flags |
| 23 | Fill3DRect | 3D-style filled rectangle with border colors |
| 42 | TouchRectangles | Defines interactive touch/click regions |
| 72 | CreateElement | DOM element creation |
| 73 | UpdateElement | Position/size/rotation update |
| 81 | SetTransform | Affine transform matrix |
| 93 | ClearRectAndClip | Clear rect + set clip |

### Continuation Handling

If the paint data is too large for one response (exceeds CommBufferSize), the response includes a non-zero continuation token. The client must send a follow-up request:

```
GetPaintData with:
  Tag 132 containing:
    Tag 4: Uint32 continuation token
```

This repeats until a response with continuation=0 (finish) is received.

## Session Teardown

On page unload, the client sends RemoveClient (group 4, id 2):
```
Tag 2: Uint32 clientId
```

Uses `navigator.sendBeacon()` or synchronous XHR for reliable delivery.

## Error Recovery

On any communication error:
1. Client logs error
2. Waits `ErrorReconnectTime` (default 10000ms)
3. Restarts entire sequence from Step 1 (reload config)

The state machine: `RetrievingConfigurationState → UploadImagePoolState → StartConnectState → RetrievingMyIpState → DeviceSessionState → [DeviceLoginState] → VisuRegistrationState → VisuPollingRegistrationState → VisuOnlineInitState1 → VisuOnlineInitState2 → VisuOnlineInitState3 → VisuOnlineState (main loop)`

## Key Constants

```
Magic:           0xCD55 (52565)
DefaultClientId: 0xABCD (43981) — sentinel before registration
ProtocolVersion: 0x70000 (458752)
Features:        7
CommBufferSize:  50000
UpdateRate:      200ms
PollingInterval: 100ms (for IsRegisteredClient)
```

## Source Code Reference

Minified names mapped to functionality in `webvisu.js`:

| Minified | Purpose |
|----------|---------|
| `Eb` | Frame header (magic, service group/id, session, content length) |
| `lb` / `mb` | TLV reader / writer (MBUI encoding) |
| `J` / `hb` / `ib` | BinaryReader variants (ArrayBuffer, DataView, String-based) |
| `O` / `kb` | BinaryWriter variants |
| `p` / `ea` | BinaryBuffer (ArrayBuffer-based / String-based fallback) |
| `n` | Event message (tag, x, y, clientId, extras) |
| `H` | Event type constants (mousedown=2, mouseup=4, mousemove=16) |
| `Fb` | Event queue (circular buffer, size 100, deduplication) |
| `Ya` | Message builder (constructs all request types) |
| `T` | Response parser (reads all response types) |
| `Xa` / `Db` | XHR communication layer |
| `la` | Session info (CommBufferSize, byteOrder, sessionId, clientId) |
| `pa` | PaintData container (commandCount, data buffer, continuation) |
| `Ja` | Paint command factory (100+ command types) |
| `Va`..`Fd` | State machine classes (see Connection Startup Sequence) |
| `Configuration` | Client config object (UpdateRate, PlcAddress, etc.) |
| `D` | Protocol constants (sessionId sentinels, result codes) |
