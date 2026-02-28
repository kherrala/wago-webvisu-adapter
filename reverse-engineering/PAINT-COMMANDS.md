# CoDeSys WebVisu Paint Commands Reference

Reverse-engineered from the `webvisu.js` canvas renderer (command factory `Ja.mz(...)`) and reimplemented in `src/protocol/paint-commands.ts` and `src/protocol/debug-renderer.ts`.

## Paint Command Stream Format

Paint commands are delivered inside `GetPaintData` responses (service group 4, service id 4). The raw command bytes are found in TLV tag 3 of the inner container (tag 132 or 129).

### Command Framing

Each command in the stream is framed as:

```
Offset  Size  Field
0       4     totalSize   (uint32 LE) — includes this 8-byte header
4       4     commandId   (uint32 LE) — identifies the command type
8       N     data        (raw bytes) — where N = totalSize - 8
```

Commands are packed sequentially with no padding between them. The parser reads commands until fewer than 8 bytes remain.

### Color Encoding (ARGB)

All colors in command payloads are encoded as a single `uint32` in **little-endian ARGB** format:

```
Bits 31..24  Alpha
Bits 23..16  Red
Bits 15..8   Green
Bits 7..0    Blue
```

An alpha of `0x00` is treated as fully opaque by the renderer (CoDeSys convention — transparent elements are simply not drawn).

### Background Color

The original browser renderer (`ra.clear`) clears the top canvas and fills the base canvas white:

```js
this.Y.clearRect(...)
this.Ea.fillStyle = "#ffffff"
this.Ea.fillRect(...)
```

The correct default background is **white** (`#ffffff`).

---

## Full Command ID → JS Class Map

From `webvisu.js` command factory `Ja.mz(...)`. Class names are obfuscated; see the command catalog below for decoded behavior.

```text
ID    Class    Description
──    ─────    ───────────
0     V        No-op / unhandled
1     Qb       DrawPrimitive (quad point variant)
2     Pb       DrawPolygon (int16 points)
3     Tb       DrawText (4-point rect variant)
4     fc       SetFillColor
5     gc       SetPenStyle
6     hc       SetFont
7     Ga       ClearRect
8     Jb       SetClipRect (push)
9     ic       RestoreClipRect (pop)
10    ec       (fill-related state)
11    Tb       DrawText variant
12    Ub       (unknown)
13    V        No-op
14    Ha       (rect draw variant)
15    Ha       (rect draw variant)
16    Kb       (unknown)
17    Vb       (unknown)
18    jc       SetDrawMode / layer switch
19    Aa       DrawImage
20    kc       (unknown)
21    lc       (unknown)
22    lc       (unknown)
23    Lb       Fill3DRect
24    mc       (unknown)
25    ec       (fill-related state)
26    bc       (unknown)
27    ac       (unknown)
28    cc       (unknown)
29    dc       (unknown)
30    nc       AreaGradientStyle
31    Sb       (unknown)
32    oc       (unknown)
33    pc       (unknown)
34    pc       (unknown)
35    qc       (unknown)
36    Nb       DrawArc / DrawPie
37    rc       InitVisualization
38    V        No-op
39    V        No-op
40    V        No-op
41    Ba       (unknown)
42    sc       TouchRectangles
43    tc       (unknown)
44    Ob       DrawPixels (point list)
45    Qb       DrawPrimitive (two-point rect)
46    Tb       DrawText (latin1)
47    Tb       DrawText (utf16le variant)
48    nc       AreaGradientStyle variant / Set3DStyle
49    uc       (unknown)
50    vc       (unknown)
51    wc       (unknown)
52    wc       (unknown)
53    xc       (unknown)
54    yc       (unknown)
55    zc       (unknown)
56    Ac       (unknown)
57    Bc       (unknown)
58    Cc       (unknown)
59    Pb       DrawPolygon (float points)
60    Qb       DrawPrimitive (float quad)
61    Qb       DrawPrimitive (float two-point rect)
62    V        No-op
63    V        No-op
64    V        No-op
65    V        No-op
66    Dc       SetRenderParameter
67    $b       (unknown)
68    Wb       (unknown)
69    Zb       (unknown)
70    V        No-op
71    Ec       (unknown)
72    Fc       (unknown)
73    Gc       SetCornerRadius / UpdateElement
74    Hc       (unknown)
75    Ic       (unknown)
76    Jc       (unknown)
77    Kc       (unknown)
78    Lc       (unknown)
79    Mc       (unknown)
80    Nc       (unknown)
81    Oc       (unknown)
82    Pc       (unknown)
83    Qc       (unknown)
84    V        No-op
85    Rc       (unknown)
86    Sc       (unknown)
87    Tc       (unknown)
88    Uc       (unknown)
89    Vc       (unknown)
90    Wc       (unknown)
91    Xc       (unknown)
92    Yc       (unknown)
93    Ib       ClearRectAndClip
94    Zc       DrawDomImage (dialog/layer integration)
95    V        No-op
96    $c       (unknown)
97    V        No-op
98    ad       (unknown)
99    bd       (unknown)
100   cd       (unknown)
101   dd       (unknown)
102   ed       (unknown)
103   fd       (unknown)
104   gd       (unknown)
105   Hb       ClearFullContext
106   hd       SetCompositeMode
8192  Ea       (extended command)
8193  Fa       (extended command)
8194  Da       (extended command)
```

---

## Paint Command Catalog

### ID 1 — DrawPrimitive (Quad Point Variant) `Qb`

Draws a geometric primitive using 4 corner points (quad).

```
Offset  Size  Field
0       2     kind        (uint16 LE) — primitive type (see ID 45)
2       16    corners     — 4 points, each (x: int16, y: int16)
```

- Same primitive kinds as ID 45 (rect, round-rect, ellipse, diagonal lines)
- Uses 4 corner points (`G.ad`) instead of 2-point bounding rect

### ID 2 — DrawPolygon `Pb`

Draws a filled and/or stroked polygon, polyline, or bezier curve from int16 points.

```
Offset  Size  Field
0       2     mode        (uint16 LE) — drawing mode / curve type
2       2     pointCount  (uint16 LE) — number of vertices (2..128)
4       N*4   points      — array of (x: int16, y: int16) pairs
```

- Fill/stroke behavior depends on the current **draw mode** (set by command 18):
  - Mode 0 or 1: fill polygon with current fill color, then stroke outline with current pen
  - Mode 2: stroke only (no fill)
- Bezier curves are approximated as polylines in the debug renderer

### ID 3 — DrawText (4-Point Variant) `Tb`

Text draw variant using 4 corner points to define the bounding rectangle.

```
Offset  Size  Field
0       16    corners     — 4 points, each (x: int16, y: int16)
16      4     flags       (uint32 LE) — alignment flags (same as ID 46)
20      2     textLen     (uint16 LE)
22      N     text        (latin1)
```

- Not commonly observed in captured sessions

### ID 4 — SetFillColor `fc`

Sets the current fill color and fill-enable flag for subsequent drawing operations.

```
Offset  Size  Field
0       4     flags       (uint32 LE) — fill flags (includes fill-disable bit)
4       4     argb        (uint32 LE) — fill color in ARGB format
```

- This is a **state command** — it affects all subsequent fill operations until the next SetFillColor
- Used by Fill3DRect (when it lacks an embedded color), ClearRect, DrawPolygon, and DrawPrimitive
- Note: the debug renderer currently reads ARGB from offset 0 (simplified parsing)

### ID 5 — SetPenStyle `gc`

Sets the current pen (outline/stroke) style, color, and width.

```
Offset  Size  Field
0       4     lineStyle   (uint32 LE) — line dash style
4       4     argb        (uint32 LE) — pen color in ARGB format
8       2     width       (uint16 LE) — pen width in pixels
10      ...   optional    — cap style, join style, miter limit (extended payload)
```

- Affects polygon outlines, rectangle strokes, line drawing via DrawPrimitive, etc.
- Note: the debug renderer uses a simplified parse (width from offset 0, color from offset 4)

### ID 6 — SetFont `hc`

Sets the current font for text rendering.

```
Offset  Size  Field
0       4     argb        (uint32 LE) — text color in ARGB format
4       4     styleFlags  (uint32 LE) — bitmask:
                            bit 0: bold
                            bit 1: italic
                            bit 2: underline
                            bit 3: strikeout
8       2     fontSize    (uint16 LE) — font size in pixels (clamped 6..96)
10      2     familyLen   (uint16 LE) — length of font family name
12      N     family      (latin1 string) — e.g. "Arial", null-terminated
```

### ID 7 — ClearRect `Ga`

Clears a rectangular region by filling it with the current fill color.

```
Offset  Size  Field
0       2     x           (int16 LE)  — or left (two-point form)
2       2     y           (int16 LE)  — or top
4       2     width       (int16 LE)  — or right
6       2     height      (int16 LE)  — or bottom
```

- Uses the current fill color (set by SetFillColor)
- Respects the active clip rectangle
- Original: uses two-point rect (`G.A`), with an optional skip-clear bit in trailing flags

### ID 8 — SetClipRect `Jb`

Pushes a new clipping rectangle onto the clip stack. Subsequent drawing is restricted to the intersection of the current clip and this rectangle.

```
Offset  Size  Field
0       2     left        (int16 LE)
2       2     top         (int16 LE)
4       2     right       (int16 LE)
6       2     bottom      (int16 LE)
```

- Coordinates are **corner points** (left/top, right/bottom), not (x, y, width, height)
- Nested clips are intersected — the effective clip shrinks with each push
- Must be balanced with RestoreClipRect (ID 9)
- Original: maps to canvas `save()` + `clip()`

### ID 9 — RestoreClipRect `ic`

Pops the most recently pushed clip rectangle, restoring the previous clipping region.

```
(no data payload)
```

- Original: maps to canvas `restore()`

### ID 18 — SetDrawMode / Layer Switch `jc`

Controls drawing mode or performs a layer/context switch.

```
Offset  Size  Field
0       2     mode        (uint16 LE)
                0 = fill + stroke (default)
                1 = fill + stroke
                2 = stroke only (no fill)
```

- In the original browser renderer, this triggers `kA`/`lA` layer/context switching
- The debug renderer treats this as a draw mode for a single cumulative canvas

### ID 19 — DrawImage `Aa`

Draws a bitmap/vector image from the PLC's image pool.

```
Offset  Size  Field
0       2     namespaceLen (uint16 LE) — length of namespace string
2       N     namespace    (latin1) — image namespace (may be empty)
2+N     2     nameLen      (uint16 LE) — length of image name
4+N     M     name         (latin1) — image name
                           Combined imageId = "{namespace}.{name}" if namespace non-empty
4+N+M   16    corners      — 4 corner points, each (x: int16, y: int16)
                           Defines a quadrilateral (usually axis-aligned rectangle)
20+N+M  4     flags        (uint32 LE) — rendering flags:
                            bit 0 (0x01): isotropic scaling
                            bit 1 (0x02): stretch to fit
                            bit 2 (0x04): tile/repeat
                            bit 3 (0x08): draw border
                            bit 4 (0x10): clip to rect
                            bit 5 (0x20): chroma key transparency (see below)
                            bit 7 (0x80): unknown
                            bit 8 (0x100): unknown
                            bit 10 (0x400): unknown
                            bit 11 (0x800): unknown
                            bit 12 (0x1000): unknown
24+N+M  4     chromaArgb   (uint32 LE) — chroma key color in ARGB format
```

- The bounding rectangle is derived from the min/max of the 4 corner points
- **Image resolution**: images are fetched from the PLC via `/ImageByImagePoolId?id=...` or looked up in `application.imagepoolcollection.csv`
- **Chroma key** (flag 0x20): pixels matching the `chromaArgb` color are made fully transparent. In webvisu.js (`Gb.Rx`), this is done via pixel-by-pixel comparison with fuzzy tolerance (±2 per channel). **SVG images are exempt** — the chroma key is only applied to raster (PNG/JPEG) sources.
- Supports PNG, JPEG, and SVG source formats

#### Status Detection via DrawImage

Lamp status indicators use named images:
- `Element-Lamp-Lamp1-Yellow-On` → light is ON
- `Element-Lamp-Lamp1-Yellow-Off` → light is OFF
- Status is inferred from the image name, not from the chroma key color

### ID 23 — Fill3DRect `Lb`

Draws a filled rectangle with optional 3D border effect.

```
Offset  Size  Field
0       2     x           (int16 LE)
2       2     y           (int16 LE)
4       2     width       (int16 LE)
6       2     height      (int16 LE)
8       4     fillArgb    (uint32 LE) — fill color (optional, uses current fill if absent)
12      4     highlightArgb (uint32 LE) — 3D highlight color (optional)
16      4     shadowArgb  (uint32 LE) — 3D shadow color (optional)
```

- Minimum payload: 8 bytes (rect only, uses current fill color)
- Extended payload (12+ bytes): embeds its own fill color
- Extended payload (20 bytes): includes 3D highlight and shadow for beveled appearance
- Original: quad rect + style/color payload; 3D style approximated to fill+stroke in debug renderer

#### Status Detection via Fill3DRect

This is the primary mechanism for detecting light switch status:
1. Look for Fill3DRect commands that overlap the status indicator coordinates
2. Use the embedded fill color (or preceding SetFillColor)
3. Yellow (R>140, G>140) = ON; brown = OFF

### ID 30 — AreaGradientStyle `nc`

Area/gradient style command that also affects the fill-disable state.

```
(variable-length payload — gradient definition)
```

- Not commonly observed in captured sessions
- See also ID 48 (variant of the same class)

### ID 36 — DrawArc / DrawPie `Nb`

Draws an arc or pie segment.

```
(variable-length payload — arc geometry)
```

- **Not implemented** in the debug renderer

### ID 37 — InitVisualization `rc`

Initializes or switches to a named visualization screen.

```
Offset  Size  Field
0       2     nameLen     (uint16 LE) — length of visualization namespace
2       N     namespace   (latin1) — visualization namespace string
```

- Sets the current visualization namespace used for image ID resolution

### ID 42 — TouchRectangles `sc`

Defines hit-test regions for interactive elements (buttons, switches).

```
(variable-length payload — touch region definitions)
```

- No visual effect — used internally for mouse/touch event routing
- Defines clickable areas on the canvas

### ID 44 — DrawPixels `Ob`

Draws individual pixels from a point list.

```
(variable-length payload — point list with colors)
```

- **Not implemented** in the debug renderer

### ID 45 — DrawPrimitive (Two-Point Rect) `Qb`

Draws geometric primitives (rectangles, lines) with the current pen and fill, using a two-point bounding rect.

```
Offset  Size  Field
0       2     kind        (uint16 LE) — primitive type:
                            0 = rectangle (filled + stroked)
                            1 = rounded rectangle
                            2 = ellipse
                            3 = line (bottom-left to top-right diagonal — `/`)
                            4 = line (top-left to bottom-right diagonal — `\`)
2       2     x1          (int16 LE) — first corner X
4       2     y1          (int16 LE) — first corner Y
6       2     x2          (int16 LE) — second corner X
8       2     y2          (int16 LE) — second corner Y
```

- Coordinates are corner points (normalized to positive width/height internally)
- Rectangles: filled with current fill color if draw mode allows, then stroked with current pen
- Lines (kind 3, 4): drawn with current pen color and width
- Uses `G.A` (two-point int16 rect) in the original

### ID 46 — DrawText (Latin1) `Tb`

Renders a text label within a bounding rectangle.

```
Offset  Size  Field
0       2     left        (int16 LE)
2       2     top         (int16 LE)
4       2     right       (int16 LE)
6       2     bottom      (int16 LE)
8       4     flags       (uint32 LE) — alignment and style flags:
                            bits 0-1: horizontal alignment
                              0 = left
                              1 = center
                              2 = right
                            bit 2: vertical center
                            bit 3: vertical bottom
12      2     textLen     (uint16 LE) — length of text string
14      N     text        (latin1) — the text content (null-padded)
```

- Uses the current font (set by SetFont command)
- Text is clipped to the bounding rectangle
- Encoding: ISO-8859-1 (Latin-1), null bytes stripped

### ID 47 — DrawText (UTF-16LE) `Tb`

Unicode variant of DrawText. Same layout as ID 46, but text is encoded as UTF-16LE.

```
Offset  Size  Field
0       2     left        (int16 LE)
2       2     top         (int16 LE)
4       2     right       (int16 LE)
6       2     bottom      (int16 LE)
8       4     flags       (uint32 LE) — alignment flags (same as ID 46)
12      2     textLen     (uint16 LE) — length of text in bytes
14      N     text        (utf16le) — Unicode text content
```

- Original: calls `aa(..., true)` for Unicode decode path

### ID 48 — Set3DStyle / AreaGradientStyle Variant `nc`

Sets border and fill colors for 3D-styled elements. Also used as an area/gradient style variant.

```
Offset  Size  Field
0       4     unknown     (uint32 LE) — reserved/flags
4       4     borderArgb  (uint32 LE) — border/outline color
8       4     fillArgb    (uint32 LE) — interior fill color
```

- Updates both the current pen color (border) and fill color simultaneously
- Gradient aspects are approximated as flat fills in the debug renderer

### ID 59 — DrawPolygon (Float Points) `Pb`

Float-precision variant of DrawPolygon (ID 2). Uses float32 coordinates instead of int16.

```
Offset  Size  Field
0       2     mode        (uint16 LE) — drawing mode / curve type
2       2     pointCount  (uint16 LE) — number of vertices
4       N*8   points      — array of (x: float32, y: float32) pairs
```

### ID 60 — DrawPrimitive (Float Quad) `Qb`

Float-precision variant of ID 1. Uses float32 quad points (`G.$r`).

```
Offset  Size  Field
0       2     kind        (uint16 LE) — primitive type
2       32    corners     — 4 points, each (x: float32, y: float32)
```

### ID 61 — DrawPrimitive (Float Two-Point Rect) `Qb`

Float-precision variant of ID 45. Uses float32 two-point rect (`G.Yr`).

```
Offset  Size  Field
0       2     kind        (uint16 LE) — primitive type
2       8     p1          — (x: float32, y: float32) first corner
10      8     p2          — (x: float32, y: float32) second corner
```

### ID 66 — SetRenderParameter `Dc`

Sets a named rendering parameter (numeric key-value pair).

```
Offset  Size  Field
0       2     parameterId (uint16 LE) — parameter identifier
2       2     reserved    (uint16 LE)
4       4     value       (int32 LE) — parameter value
```

- Controls rendering behavior (font reduction, timeouts, etc.)
- Stored in a key-value map for the rendering session

### ID 73 — UpdateElement / SetCornerRadius `Gc`

Marks a UI element as requiring a redraw, and/or sets the corner radius for rounded rectangles.

```
Offset  Size  Field
0       2     radiusX     (int16 LE) — horizontal corner radius
2       2     radiusY     (int16 LE) — vertical corner radius
```

- Original: `TA(x, y)` for rounded rectangle corners
- Also acts as a logical grouping marker for element invalidation

### ID 93 — ClearRectAndClip `Ib`

Combined clear and clip operation: fills a rectangle with the current fill color AND sets it as the active clip rectangle.

```
Offset  Size  Field
0       2     x           (int16 LE)
2       2     y           (int16 LE)
4       2     width       (int16 LE)
6       2     height      (int16 LE)
```

- Same data layout as ClearRect (ID 7), uses `G.A` (two-point rect)
- Additionally replaces the current clip rectangle with this rect

### ID 94 — DrawDomImage `Zc`

DOM image element draw path for dialog/layer integration.

```
(variable-length payload — DOM image reference)
```

- **Not implemented** in the debug renderer
- Used for overlay dialogs and separate rendering layers

### ID 105 — ClearFullContext `Hb`

Clears the entire current rendering context.

```
(no data payload, or minimal header)
```

- Original: `wy()` → `clearRect(0, 0, w, h)` on the full canvas
- Resets the visible area to the background color

### ID 106 — SetCompositeMode `hd`

Sets the canvas composite/blending operation.

```
Offset  Size  Field
0       2     mode        (uint16 LE) — composite mode:
                            0 = copy (overwrite)
                            1 = source-over (alpha blend, default)
```

- Original: maps to canvas `globalCompositeOperation`
- Debug renderer currently always uses source-over (alpha blend)

---

## Extended Commands (8192+)

These command IDs appear in the factory but are rarely seen in normal visualization sessions:

| ID | Class | Notes |
|----|-------|-------|
| 8192 | `Ea` | Extended command (purpose unknown) |
| 8193 | `Fa` | Extended command (purpose unknown) |
| 8194 | `Da` | Extended command (purpose unknown) |

---

## Implementation Status Summary

| ID | Name | Debug Renderer | Notes |
|---:|------|:--------------:|-------|
| 1 | DrawPrimitive (quad) | Yes | |
| 2 | DrawPolygon (int16) | Yes | Bezier approximated as polyline |
| 3 | DrawText (4-point) | No | Not seen in captures |
| 4 | SetFillColor | Yes | Simplified offset parsing |
| 5 | SetPenStyle | Yes | Simplified offset parsing |
| 6 | SetFont | Yes | |
| 7 | ClearRect | Yes | |
| 8 | SetClipRect | Yes | |
| 9 | RestoreClipRect | Yes | |
| 18 | SetDrawMode | Yes | Single canvas (no layers) |
| 19 | DrawImage | Yes | With PLC image fetch + tint |
| 23 | Fill3DRect | Yes | 3D style approximated |
| 30 | AreaGradientStyle | No | Not seen in captures |
| 36 | DrawArc/Pie | No | Not implemented |
| 37 | InitVisualization | Yes | |
| 42 | TouchRectangles | Yes | No-op (metadata only) |
| 44 | DrawPixels | No | Not implemented |
| 45 | DrawPrimitive (2pt) | Yes | |
| 46 | DrawText (latin1) | Yes | |
| 47 | DrawText (utf16) | Yes | UTF-16LE decode fallback |
| 48 | Set3DStyle | Yes | Gradient approximated |
| 59 | DrawPolygon (float) | Yes | |
| 60 | DrawPrimitive (f.quad) | Yes | |
| 61 | DrawPrimitive (f.2pt) | Yes | |
| 66 | SetRenderParameter | Yes | Metadata cached |
| 73 | UpdateElement/CornerRadius | Yes | |
| 93 | ClearRectAndClip | Yes | |
| 94 | DrawDomImage | No | Dialog/layer integration |
| 105 | ClearFullContext | Yes | |
| 106 | SetCompositeMode | Partial | Always source-over |

---

## Paint Event Types (Input Events)

These are the event tags sent TO the PLC via `GetPaintData` requests (service group 4, service id 4, wrapped in TLV tag 132 → tag 1):

### Event Header Format

```
Offset  Size  Field
0       4     eventTag    (uint32 LE) — event type identifier
4       4     param1      (uint32 LE) — primary parameter (packed coordinates for mouse events)
8       4     param2      (uint32 LE) — secondary parameter
12      4     clientId    (uint32 LE) — registered client ID
```

Optional extra data follows in TLV tag 2.

### Event Tag Catalog

| Tag | Name | param1 | param2 | Extra Data |
|-----|------|--------|--------|------------|
| 1 | **Heartbeat** | 0 | 0 | none |
| 2 | **MouseDown** | packed(x,y) | 0 | none |
| 4 | **MouseUp** | packed(x,y) | 0 | none |
| 8 | **MouseClick** | packed(x,y) | 0 | none |
| 16 | **MouseMove** | packed(x,y) | 0 | none |
| 32 | **MouseDblClick** | packed(x,y) | 0 | none |
| 64 | **MouseWheel** | — | — | — |
| 256 | **KeyDown** | — | — | — |
| 512 | **KeyUp** | — | — | — |
| 1024 | **KeyPress** | — | — | — |
| 2048 | **MouseEnter** | — | — | — |
| 4096 | **MouseOut** | — | — | — |
| 516 | **ViewportInfo** | viewportFlags | 0 | viewport rect + DPR (see below) |
| 1048576 | **Control** | 0 | 0 | control payload (see below) |

### Coordinate Packing (Mouse Events)

For MouseDown (2), MouseUp (4), and MouseMove (16), coordinates are packed into `param1`:

```
param1 = ((x & 0xFFFF) << 16) | (y & 0xFFFF)
```

Unpacking:
```
x = (param1 >>> 16) & 0xFFFF
y = param1 & 0xFFFF
```

### ViewportInfo Extra Data (Tag 516)

```
Offset  Size  Field
0       2     viewportX   (int16 LE) — always 0
2       2     viewportY   (int16 LE) — always 0
4       2     width-1     (int16 LE) — viewport width minus 1
6       2     height-1    (int16 LE) — viewport height minus 1
8       4     dpr         (float32 LE) — device pixel ratio (typically 1.0)
```

### Capabilities Control Event (Tag 1048576)

Used for both capabilities announcement and StartVisu:

**Capabilities payload:**
```
Offset  Size  Field
0       4     protocolVersion  (uint32 LE) — 0x70000 (458752)
4       4     features         (uint32 LE) — bitmask, value 7
8       4     inputFlags       (uint32 LE) — 0 (no keyboard, no touch)
```

**StartVisu payload:**
```
Offset  Size  Field
0       4     command     (uint32 LE) — 1 = start visualization
4       N+1   visuName    (null-terminated latin1 string) — e.g. "Visualization"
```

---

## Paint Data Response Format

Responses arrive in a frame (service group 4, service id 4) with TLV structure:

```
Container (tag 132 or 129):
  tag 1: error code (uint32 LE) — 0 = success
  tag 2: paint header (16 bytes):
    offset 0: unused (uint32 LE)
    offset 4: commandCount (uint32 LE) — number of commands in this chunk
    offset 8: totalSize (uint32 LE) — total byte size of all command data
    offset 12: continuation (uint32 LE) — token for fetching remaining data (0 = complete)
  tag 3: raw paint command data (byte stream parsed per "Command Framing" above)
  tag 4: finish marker — continuation complete (token = 0)
```

### Continuation Protocol

When `continuation` is non-zero, the response is incomplete. Send a continuation request:

```
TLV tag 132 → tag 4: continuation token (uint32 LE)
```

Wrapped in a GetPaintData service request (group 4, id 4). Repeat until continuation = 0 or a tag 4 finish marker is received.

---

## Rendering State Machine

The paint command stream is stateful. The renderer maintains:

| State Variable | Default | Modified By |
|---------------|---------|-------------|
| Fill color | white (#ffffff) | SetFillColor (4), Set3DStyle (48) |
| Fill enabled | true | SetFillColor (4) flags |
| Pen color | implementation-defined | SetPenStyle (5), Set3DStyle (48) |
| Pen width | 1 | SetPenStyle (5) |
| Pen line style | solid | SetPenStyle (5) |
| Font | Arial 12px | SetFont (6) |
| Draw mode | 0 (fill+stroke) | SetDrawMode (18) |
| Clip rectangle | none (full canvas) | SetClipRect (8), RestoreClipRect (9), ClearRectAndClip (93) |
| Clip stack | empty | SetClipRect (8) pushes, RestoreClipRect (9) pops |
| Corner radius | (0, 0) | UpdateElement/SetCornerRadius (73) |
| Composite mode | source-over | SetCompositeMode (106) |
| Visualization namespace | "" | InitVisualization (37) |
| Render parameters | empty map | SetRenderParameter (66) |

Commands are processed sequentially. State commands affect all subsequent drawing commands until the state is changed again.
