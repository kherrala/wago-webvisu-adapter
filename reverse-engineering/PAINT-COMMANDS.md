# CoDeSys WebVisu Paint Commands Reference

Reverse-engineered from the CoDeSys WebVisu canvas renderer. See `webvisu-deobfuscated.js` for the reference implementation (all 107 command classes fully identified). Our adapter implements a subset in `src/protocol/paint-commands.ts` and `src/protocol/debug-renderer.ts`.

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

## Full Command ID → Class Map

From the command factory `PaintCommandFactory.createCommand(...)`. All class names have been identified through reverse engineering.

```text
ID    Class                    Description
──    ─────                    ───────────

      ── Drawing Primitives ──
0     NoOpPaintCommand         No-op / unhandled
1     DrawPrimitive            Quad-point rect/ellipse/line
2     DrawPolygon              Filled/stroked polygon (int16 points)
3     DrawText                 Text with 4-point bounding rect
23    Fill3DRect               Filled rect with optional 3D border
36    DrawArc                  Arc / pie segment
44    DrawPixels               Individual pixel points
45    DrawPrimitive            Two-point rect variant
59    DrawPolygon              Float-point polygon variant
60    DrawPrimitive            Float quad-point variant
61    DrawPrimitive            Float two-point variant

      ── Graphics State ──
4     SetFillColor             Fill color + fill-enable flag
5     SetPenStyle              Outline style, color, width
6     SetFont                  Text color, style, size, family
18    SetDrawMode              Drawing mode / layer switch
24    SetCursorStyle           Set mouse cursor CSS style
30    AreaGradientStyle        Gradient/fill style
48    AreaGradientStyle        3D style variant (border + fill colors)
66    SetRenderParameter       Numeric key-value render parameter
73    SetCornerRadius          Corner radius for rounded rects
85    SetStrokeStyle           Line width, dash pattern, and color
106   SetCompositeMode         Canvas composite/blending mode

      ── Text Rendering ──
11    DrawText                 DrawText variant
46    DrawText                 Latin-1 text with bounding rect
47    DrawText                 UTF-16LE text with bounding rect
71    DrawTextASCII            ASCII text with font metrics
72    DrawTextUnicode          Unicode text with font metrics

      ── Clipping and Clearing ──
7     ClearRect                Fill rect with current fill color
8     SetClipRect              Push clipping rectangle
9     RestoreClipRect          Pop clipping rectangle
93    ClearRectAndClip         Combined clear + clip
105   ClearFullContext          Clear entire canvas

      ── Text Input Controls ──
10    CreateEditControl        Create styled text input (Latin-1)
12    SetEditControlState      Close/reset text edit control
25    CreateEditControl        Create styled text input (Unicode)

      ── Text Measurement (PLC ↔ browser) ──
32    ClearTextMeasureCache    Clear text width measurement cache
33    MeasureTextMetrics       Measure text widths (Latin-1)
34    MeasureTextMetrics       Measure text widths (Unicode)
35    SendTextMetricsEvent     Send measured widths to PLC (event 518)
50    ClearTextBreakCache      Clear text break position cache
51    PopulateTextBreakCache   Calculate text break positions (Latin-1)
52    PopulateTextBreakCache   Calculate text break positions (Unicode)
53    SendTextBreakData        Send break positions to PLC (event 519)

      ── Image Rendering ──
19    DrawImage                Bitmap/vector from image pool
94    DrawDomImage             DOM image for dialog/layer

      ── Double-Buffer / Offscreen Rendering ──
54    AllocateDoubleBuffer     Create offscreen rendering surface
55    FreeDoubleBuffer         Deallocate offscreen buffer
56    InvalidateBuffer         Mark buffer as needing re-render
57    CommitDoubleBuffer       Finalize offscreen rendering
58    SetGlyphMetrics          Store glyph metrics for text element

      ── UI Element Lifecycle ──
74    CreateUIElement          Create and register UI element
75    UpdateContainerLayout    Update position/size with animation
76    RemoveUIElement          Remove/hide element by ID
77    ResetContainer           Reset/clear UI container
78    ClearAndComposite        Flush rendering and clear canvas
100   HideMultipleElements     Hide/remove multiple elements by ID
101   DeleteMultipleElements   Delete/finalize multiple elements by ID
92    RefreshVisualization     Trigger full repaint

      ── Layer Management ──
81    SelectLayer              Activate/select rendering layer
82    ResetLayerStack          Reset/clear layer stack
83    SetTransformMatrix       Set 6-parameter transform matrix
96    SetLayerVisibility       Control layer visibility state
102   DeactivateLayer          Deactivate layer/context
103   SetLayerPosition         Set layer position (float32 coords)

      ── Dialog and View Navigation ──
88    OpenModalDialog          Open modal dialog with config
89    SwitchMainView           Navigate to different page/view
90    AnimateWithOpacity       Animate container with opacity
91    CloseDialog              Close/dismiss modal dialog
99    ClearModalState          Clear current modal state

      ── Dynamic Controls and Menus ──
79    CreateMenuItem           Create/register menu option
80    ConfigureDrawingContext  Configure advanced canvas parameters
86    CreateDynamicControl     Instantiate UI control by class name
87    SetElementProperties     Set typed properties on named element
104   AnimateElementTransform  Animate with float transform + easing

      ── Tooltip ──
14    DrawTooltip              Tooltip (Latin-1 text, styled box)
15    DrawTooltip              Tooltip (UTF-16 text)
16    CloseTooltip             Remove tooltip DOM element

      ── System Actions ──
17    ExecuteSystemAction      Navigate URL, print, or start process
20    ExecuteClientProgram     Unsupported in web (logs warning)
21    OpenFileDialog           Unsupported in web (logs warning)
22    OpenFileDialog           Unsupported in web (logs warning)
41    InvalidateDisplay        Force redraw via gesture handler
98    LogEvent                 Log diagnostic message to console

      ── Native Controls / Extensions ──
26    NativeControlCreate      Create native control element
27    ExtensionMethodCall      Call method on native extension
28    NativeControlResize      Resize native control
29    NativeControlFlags       Set control flags or destroy

      ── File Transfer ──
67    FileTransferCommand      Initiate file transfer
68    FileTransferInitiate     File transfer stream metadata
69    FileTransferDataChunk    File transfer data chunk

      ── Namespace and Touch ──
37    InitVisualization        Switch to named visu screen
42    TouchHandlingFlags       Global touch/render flags
43    TouchRectangles          Hit-test rectangles
49    RegisterNamespaces       Register namespace entries

      ── Glyph Data ──
31    DrawShapeAtPen           Draw shape at pen, advance position

      ── Extended Session Commands ──
8192  NavigateSession          Navigate/activate session resource
8193  ExecuteSessionScript     Execute script in visu session
8194  SetSessionTimeout        Configure session render timeout

      ── No-ops (reserved/unused slots) ──
0     NoOpPaintCommand
13    NoOpPaintCommand
38-40 NoOpPaintCommand
62-65 NoOpPaintCommand
70    NoOpPaintCommand
84    NoOpPaintCommand
95    NoOpPaintCommand
97    NoOpPaintCommand
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

### ID 42 — TouchHandlingFlags `sc`

Global touch/render capability flags (small fixed payload).

```
Offset  Size  Field
0       4     flags       (uint32 LE)
```

Observed/decoded bits:

- `0x01` — touch/gesture handling active
- `0x02` — semi-transparency mode active
- `0x04` — touch clip/feedback behavior flag (used by touch handler state)

No direct visual drawing effect.

### ID 43 — TouchRectangles `tc`

Defines hit-test rectangles and optional scroll/zoom metadata used for event routing.

Payload is a sequence of records:

```
recordHeader (uint32 LE):
  if bit31=1: new rectangle record
    bits0..30 = rectFlags
    next uint32 = touchId
    next 8 bytes = x1,y1,x2,y2 (int16 LE)
  else: property record for the most recent rectangle
    bits16..30 = propertyType
    bits0..15  = propertyLength
    next N bytes = property payload
```

Rectangle geometry:

- Parsed from `(x1,y1,x2,y2)` as a normalized two-point rectangle
- Bottom-right coordinate is decremented by 1 (`right--`, `bottom--`) in the original implementation

Known property types:

- `3`: scroll limits (`int32 x4`) → min/max scroll vectors
- `4`: zoom limits (`float32 x2`) → min/max zoom
- `5`: unknown (`uint16 x4`) — parsed but not currently used
- `6`: sub-target mapping (`uint16,uint16,uint8,uint8,uint16,uint16`) — layer/offset metadata

No direct visual drawing effect, but critical for precise hit-testing.

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

### ID 73 — SetCornerRadius

Sets the corner radius for rounded rectangles.

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

## Newly Identified Commands

### ID 10, 25 — CreateEditControl

Creates a styled HTML text input field for user editing. ID 10 uses Latin-1 encoding, ID 25 uses Unicode.

```
Offset  Size  Field
0       8     bounds       — bounding rectangle (4× int16)
...     2     fontFlags    — italic (bit), bold (bit)
...     2     fontSize     (uint16) — font size in pixels
...     N     fontFamily   — font family name string
...     2     alignment    (uint16) — bit 0=center, bit 1=right, bit 2=vtop, bit 3=vbottom
...     N     text         — initial text content
```

- For ID 25: additional password flag and Unicode encoding flag
- Registers the input element with the `EditControlManager`

### ID 12 — SetEditControlState

Closes or resets the active text edit control.

```
Offset  Size  Field
0       2     action      (uint16) — 0 or 2 = close + reset; other = reset only
```

### ID 14, 15 — DrawTooltip

Renders a tooltip with styled background box and text. ID 14 uses Latin-1, ID 15 uses UTF-16.

```
Offset  Size  Field
0       2     textLen     (uint16)
2       N     text        — tooltip text content
...     4     anchorPoint — (x: int16, y: int16) anchor position
...     2     style       (uint16) — 1 = popup-style tooltip
```

- Desktop: draws yellow (#ffffe1) background with black border and text
- Mobile: uses native tooltip manager
- Supports multi-line text wrapping

### ID 16 — CloseTooltip

Removes the tooltip DOM element. No data payload.

### ID 17 — ExecuteSystemAction

Performs a system action: URL navigation, printing, or process start.

```
Offset  Size  Field
0       2     actionCode  (uint16) — 0=process, 1-3=print, 4=navigate
2       2     urlLen      (uint16)
4       N     url         — URL or path string
...     2     targetLen   (uint16) — optional
...     M     target      — "replace" for same-window navigation
```

- Action 0: logs "start process not possible in web"
- Actions 1-3: logs "printing not possible in web"
- Action 4: `window.open(url)` or `window.location.href = url` if target is "replace"

### ID 20 — ExecuteClientProgram

Logs warning "ExecuteClientProgram is not possible in the webvisualization." No data payload.

### ID 21, 22 — OpenFileDialog

Logs warning "OpenFileDialog is not possible in the webvisualization." No data payload.

### ID 24 — SetCursorStyle

Sets the mouse cursor CSS style on the canvas element.

```
Offset  Size  Field
0       2     cursorType  (uint16) — cursor code:
                            0, 2 = "pointer"
                            1 = "default"
                            3 = "wait"
                            4 = "text"
                            5 = "crosshair"
                            6 = "help"
                            7 = "col-resize"
                            8 = "row-resize"
                            9 = "nw-resize"
                            10 = "ne-resize"
                            11 = "w-resize"
                            12 = "s-resize"
                            13 = "pointer"
```

### ID 31 — DrawShapeAtPen

Draws a shape (via `ShapeRenderer`) at the current pen position, then optionally advances the pen.

```
Offset  Size  Field
0       2     shapeType   (uint16) — shape type code for ShapeRenderer
2       4     cellSize    — (width: uint16, height: uint16) shape dimensions
6       4     advance     — (dx: uint16, dy: uint16) pen advance after draw
10      4     flags       (uint32) — bit 0=advance X, bit 1=advance Y, bit 2=use reference rect
```

- Used for table cell rendering with automatic pen advancement

### ID 32 — ClearTextMeasureCache

Clears the cached text width measurements used for text layout.

```
Offset  Size  Field
0       4     unused1     (uint32)
4       4     unused2     (uint32)
```

### ID 33, 34 — MeasureTextMetrics

Measures text widths for each substring (1 char to full length) and caches the results. Used by the PLC for text line-breaking calculations. ID 33 uses Latin-1, ID 34 uses Unicode.

```
Offset  Size  Field
0       2     textLen     (uint16)
2       N     text        — text to measure
```

### ID 35 — SendTextMetricsEvent

Serializes cached text width/height measurements into a binary payload and sends them to the PLC as event tag 518. No data payload.

### ID 41 — InvalidateDisplay

Forces a UI redraw by invoking the gesture event handler. No data payload.

### ID 49 — RegisterNamespaces

Registers namespace entries with the namespace resolver for qualified name resolution.

```
(variable-length payload — namespace string table and index arrays)
```

### ID 50 — ClearTextBreakCache

Clears the text break position cache. Same layout as ClearTextMeasureCache (two unused uint32).

### ID 51, 52 — PopulateTextBreakCache

Calculates text break positions (character boundaries for line wrapping). ID 51 uses Latin-1, ID 52 uses Unicode.

```
Offset  Size  Field
0       2     textLen     (uint16)
2       N     text        — text to analyze for break positions
```

### ID 53 — SendTextBreakData

Serializes cached text break positions into a binary payload and sends them to the PLC as event tag 519. No data payload.

### ID 54 — AllocateDoubleBuffer

Creates a double-buffered offscreen rendering surface and stores it in the command cache.

```
Offset  Size  Field
0       2     cacheId     (uint16) — ID for storing in command cache
2       2     width       (uint16) — buffer width in pixels
4       2     height      (uint16) — buffer height in pixels
6       4     flags       (uint32) — creation flags
```

- Creates white-filled canvas(es) as offscreen rendering targets
- Part of the layered graphics composition system

### ID 55 — FreeDoubleBuffer

Deallocates an offscreen buffer and removes associated gesture targets.

```
Offset  Size  Field
0       2     cacheId     (uint16) — buffer to free
```

### ID 56 — InvalidateBuffer

Marks a cached rendering buffer as dirty, requiring re-render on next access.

```
Offset  Size  Field
0       2     cacheId     (uint16) — buffer to invalidate
```

### ID 57 — CommitDoubleBuffer

Finalizes offscreen rendering: optionally copies visible context to offscreen, marks buffer clean.

```
Offset  Size  Field
0       2     cacheId     (uint16) — buffer to commit
```

### ID 58 — SetGlyphMetrics

Stores glyph rendering metrics (height, style, offset) for a specific glyph index on an interactive element.

```
Offset  Size  Field
0       4     elementId   (uint32) — target interactive element
2       2     glyphIndex  (uint16)
4       2     height      (uint16)
6       1     italic      (boolean)
7       1     bold        (boolean)
8       4     offset      — (x: uint16, y: uint16) glyph offset
```

### ID 68 — FileTransferInitiate

Initiates a file transfer stream with protocol metadata.

```
Offset  Size  Field
0       1     version     (uint8) — protocol version (normalized to 2 or 3)
1       N     packet      — ProtocolDataPacket with transfer metadata
```

### ID 69 — FileTransferDataChunk

Delivers a chunk of file transfer data.

```
Offset  Size  Field
0       4     flags       (uint32) — bit 0 signals completion
4       2     nameLen     (uint16)
6       N     filename    — transfer filename
...     4     dataLen     (uint32)
...     M     data        — raw file bytes
```

### ID 71, 72 — DrawTextASCII / DrawTextUnicode

Text rendering with font metrics (extends FontTextCommand base). ID 71 uses ASCII, ID 72 uses Unicode.

```
Offset  Size  Field
0       4     colorFlags  (uint32) — from FontTextCommand base
4       2     position    (int16) — text position parameter
6       2     textLen     (uint16)
8       N     text        — text content
```

### ID 74 — CreateUIElement

Creates and registers a UI element (canvas, dialog, native control, etc.) with configuration flags.

```
Offset  Size  Field
0       2     elementId   (int16) — unique element ID
2       4     flags       (uint32) — 8 configuration bits controlling element type and behavior
```

### ID 75 — UpdateContainerLayout

Updates element position, size, and transform with optional CSS animation.

```
Offset  Size  Field
0       10    position    — left, top, width, height, offsetX (5× int16)
10      4     moreParams  — offsetY, transformA, transformB, extraParam (int16 values)
...     2     duration    (int16) — animation duration in milliseconds
...     4     flags       (uint32) — bit 2 = deferred update
```

### ID 76 — RemoveUIElement

Removes/hides a UI element by ID.

```
Offset  Size  Field
0       2     elementId   (int16)
```

### ID 77 — ResetContainer

Resets/clears the current UI container. Parses an int16 ID (unused in execution).

### ID 78 — ClearAndComposite

Flushes previous rendering, clears the entire canvas (save/clearRect/restore), and updates dirty regions. No data payload.

### ID 79 — CreateMenuItem

Creates and registers a menu option.

```
Offset  Size  Field
0       2     menuId      (int16) — 32767 = system/special item
2       4     flags       (uint32) — optional configuration (only if size ≥ 3)
```

### ID 80 — ConfigureDrawingContext

Configures advanced canvas/drawing parameters with up to 11 values.

```
Offset  Size  Field
0       8     bounds      — left, top, width, height (4× int16)
8       2     flags       — boolean flags (2 bits)
10      1     param       (uint8) — context parameter
11      8     extraBounds — optional additional bounds (4× int16)
```

### ID 81 — SelectLayer

Activates/selects a rendering layer by ID.

```
Offset  Size  Field
0       2     layerId     (int16)
```

### ID 82 — ResetLayerStack

Resets/clears the layer stack. Parses an int16 (unused in execution).

### ID 83 — SetTransformMatrix

Sets a 6-parameter affine transform/clip matrix.

```
Offset  Size  Field
0       24    matrix      — 6× int32 values (transform coefficients)
```

### ID 85 — SetStrokeStyle

Sets line width, dash style, and stroke color.

```
Offset  Size  Field
0       2     lineWidth   (int16) — stroke width
2       2     dashType    (int16) — 0,5=solid, 1=dashed, 2-4=dotted
4       4     colorArgb   (uint32) — stroke color in ARGB
```

### ID 86 — CreateDynamicControl

Instantiates a UI control by class name string.

```
Offset  Size  Field
0       2     nameLen     (uint16)
2       N     className   — control class/type name
```

### ID 87 — SetElementProperties

Sets typed properties on a named element.

```
Offset  Size  Field
0       2     nameLen     (uint16)
2       N     elementName — target element name
...     M     properties  — array of typed property values (type code + binary data)
```

- Supported types: BOOL, BYTE, WORD, DWORD, FLOAT, DOUBLE, STRING

### ID 88 — OpenModalDialog

Opens a modal dialog with extensive configuration.

```
Offset  Size  Field
0       2     dialogId    (int16)
2       2     layerIndex  (int16) — layer/visibility index
4       4     flags       (uint32) — multiple boolean/flag fields
...     N     subFlags    — additional dialog options (8+ sub-flags)
```

### ID 89 — SwitchMainView

Navigates to a different page/view.

```
Offset  Size  Field
0       2     viewId      (int16)
2       2     layerIndex  (int16) — layer/visibility index
```

### ID 90 — AnimateWithOpacity

Animates a container with both transform and opacity transition.

```
Offset  Size  Field
0       8     bounds      — left, top, width, height (4× int16)
8       2     duration    (int16) — animation duration in ms
10      4     colorArgb   (uint32) — RGBA opacity/color value
```

### ID 91 — CloseDialog

Closes/dismisses a modal dialog.

```
Offset  Size  Field
0       2     dialogId    (int16)
```

### ID 92 — RefreshVisualization

Triggers a full repaint of the visualization. Parses an int16 (unused in execution).

### ID 96 — SetLayerVisibility

Controls the visibility state of a layer.

```
Offset  Size  Field
0       1     visibility  (uint8) — visibility flag/level
```

### ID 98 — LogEvent

Logs a diagnostic message to the browser console at the appropriate log level.

```
Offset  Size  Field
0       2     level       (uint16) — 0=no-op, 1=info, 2=warn, 4,8=error, 16=debug
2       2     messageId   (uint16)
4       2     textLen     (uint16)
6       N     text        — message description
```

### ID 99 — ClearModalState

Clears/closes the current modal dialog state (only when ID = 32767).

```
Offset  Size  Field
0       2     modalId     (int16) — 32767 triggers clear
```

### ID 100 — HideMultipleElements

Hides/removes multiple UI elements by ID array.

```
Offset  Size  Field
0       N     elementIds  — array of int16 element IDs
```

### ID 101 — DeleteMultipleElements

Deletes/finalizes multiple UI elements by ID array.

```
Offset  Size  Field
0       N     elementIds  — array of int16 element IDs
```

### ID 102 — DeactivateLayer

Deactivates a specific layer/context.

```
Offset  Size  Field
0       2     layerId     (int16)
```

### ID 103 — SetLayerPosition

Sets layer position using float32 coordinates.

```
Offset  Size  Field
0       4     x           (float32) — X position
4       4     y           (float32) — Y position
```

### ID 104 — AnimateElementTransform

Animates element position/size/scale with configurable duration and float transform parameters.

```
Offset  Size  Field
0       8     bounds      — left, top, width, height (4× int16)
8       4     offsets     — offsetX, offsetY (2× int16)
12      8     transform   — transformA, transformB (2× float32)
20      2     extraParam  (int16)
22      2     duration    (int16) — animation duration in ms
24      4     flags       (uint32) — configuration bitmask
```

---

## Extended Commands (8192+)

Extended session-level commands, rarely seen in normal visualization rendering:

### ID 8192 — NavigateSession

Navigates to or activates a session resource by name.

```
Offset  Size  Field
0       2     nameLen     (uint16)
2       N     name        — resource name string
2+N     2     param       (uint16) — activation parameter
```

### ID 8193 — ExecuteSessionScript

Executes a script or command string in the visualization session.

```
Offset  Size  Field
0       2     scriptLen   (uint16)
2       N     script      — script/command string
```

### ID 8194 — SetSessionTimeout

Configures the session rendering timeout or refresh interval.

```
Offset  Size  Field
0       4     timeout     (uint32) — timeout/interval value
```

---

## Implementation Status Summary

Commands implemented in `src/protocol/paint-commands.ts` and `src/protocol/debug-renderer.ts`:

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
| 10,25 | CreateEditControl | No | Text input field lifecycle |
| 12 | SetEditControlState | No | Edit control close/reset |
| 14,15 | DrawTooltip | No | Tooltip with styled box |
| 16 | CloseTooltip | No | Tooltip removal |
| 17 | ExecuteSystemAction | No | URL navigation / print |
| 18 | SetDrawMode | Yes | Single canvas (no layers) |
| 19 | DrawImage | Yes | With PLC image fetch + tint |
| 20 | ExecuteClientProgram | No | Unsupported in web |
| 21,22 | OpenFileDialog | No | Unsupported in web |
| 23 | Fill3DRect | Yes | 3D style approximated |
| 24 | SetCursorStyle | No | CSS cursor on canvas |
| 30 | AreaGradientStyle | No | Not seen in captures |
| 31 | DrawShapeAtPen | No | Shape at pen position |
| 32 | ClearTextMeasureCache | No | Text layout helper |
| 33,34 | MeasureTextMetrics | No | Text width measurement |
| 35 | SendTextMetricsEvent | No | Sends event 518 to PLC |
| 36 | DrawArc/Pie | No | Not implemented |
| 37 | InitVisualization | Yes | |
| 41 | InvalidateDisplay | No | Force redraw |
| 42 | TouchHandlingFlags | Yes | No-op (metadata only) |
| 43 | TouchRectangles | Yes | No-op (metadata only) |
| 44 | DrawPixels | No | Not implemented |
| 45 | DrawPrimitive (2pt) | Yes | |
| 46 | DrawText (latin1) | Yes | |
| 47 | DrawText (utf16) | Yes | UTF-16LE decode fallback |
| 48 | Set3DStyle | Yes | Gradient approximated |
| 49 | RegisterNamespaces | No | Namespace resolver setup |
| 50 | ClearTextBreakCache | No | Text break positions |
| 51,52 | PopulateTextBreakCache | No | Text break calculation |
| 53 | SendTextBreakData | No | Sends event 519 to PLC |
| 54 | AllocateDoubleBuffer | No | Offscreen surface |
| 55 | FreeDoubleBuffer | No | Deallocate buffer |
| 56 | InvalidateBuffer | No | Mark buffer dirty |
| 57 | CommitDoubleBuffer | No | Finalize rendering |
| 58 | SetGlyphMetrics | No | Glyph info storage |
| 59 | DrawPolygon (float) | Yes | |
| 60 | DrawPrimitive (f.quad) | Yes | |
| 61 | DrawPrimitive (f.2pt) | Yes | |
| 66 | SetRenderParameter | Yes | Metadata cached |
| 67 | FileTransferCommand | No | File transfer init |
| 68 | FileTransferInitiate | No | Transfer metadata |
| 69 | FileTransferDataChunk | No | Transfer data |
| 71 | DrawTextASCII | No | Font-metric text render |
| 72 | DrawTextUnicode | No | Font-metric text render |
| 73 | SetCornerRadius | Yes | |
| 74 | CreateUIElement | No | Element lifecycle |
| 75 | UpdateContainerLayout | No | Animated layout |
| 76 | RemoveUIElement | No | Element removal |
| 77 | ResetContainer | No | Container reset |
| 78 | ClearAndComposite | No | Flush + clear |
| 79 | CreateMenuItem | No | Menu registration |
| 80 | ConfigureDrawingContext | No | Canvas config |
| 81 | SelectLayer | No | Layer activation |
| 82 | ResetLayerStack | No | Layer reset |
| 83 | SetTransformMatrix | No | Affine transform |
| 85 | SetStrokeStyle | No | Line style/color |
| 86 | CreateDynamicControl | No | Dynamic UI control |
| 87 | SetElementProperties | No | Property update |
| 88 | OpenModalDialog | No | Dialog creation |
| 89 | SwitchMainView | No | Page navigation |
| 90 | AnimateWithOpacity | No | Opacity animation |
| 91 | CloseDialog | No | Dialog dismissal |
| 92 | RefreshVisualization | No | Full repaint |
| 93 | ClearRectAndClip | Yes | |
| 94 | DrawDomImage | No | Dialog/layer image |
| 96 | SetLayerVisibility | No | Layer visibility |
| 98 | LogEvent | No | Console logging |
| 99 | ClearModalState | No | Modal cleanup |
| 100 | HideMultipleElements | No | Batch hide |
| 101 | DeleteMultipleElements | No | Batch delete |
| 102 | DeactivateLayer | No | Layer deactivation |
| 103 | SetLayerPosition | No | Float position |
| 104 | AnimateElementTransform | No | Float animation |
| 105 | ClearFullContext | Yes | |
| 106 | SetCompositeMode | Partial | Always source-over |
| 8192 | NavigateSession | No | Session navigation |
| 8193 | ExecuteSessionScript | No | Script execution |
| 8194 | SetSessionTimeout | No | Render timeout |

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
