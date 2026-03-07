# WebVisu Symbol Reference

Property and method names that are reused across multiple classes and cannot be
safely auto-renamed. Use this as a reading aid alongside `webvisu-deobfuscated.js`.

Auto-renamed symbols are in `deobfuscate-transform.js`.

## Common Short Method Names

These single-letter methods have **different meanings** depending on the class:

| Method | On ResponseParser | On MessageBuilder | On BinaryWriter | On Util | On Logger |
|--------|-------------------|-------------------|-----------------|---------|-----------|
| `.b()` | readGetPaintData | writeUint32 (`.B()`) | — | getCurrentTime | debug |
| `.i()` | readOpenConnection | — | — | formatString | trace |
| `.R()` | readRegisterClient | — | — | formatPoint | — |
| `.A()` | readDeviceLogin | — | — | getTextHeight | setLevel |
| `.pa()` | readGetMyIp | — | — | — | — |
| `.fa()` | readDeviceSession | — | — | — | — |
| `.Ia()` | readIsRegistered | — | — | — | — |

## BinaryWriter Methods

| Minified | Name | Description |
|----------|------|-------------|
| `.va(a)` | writeUint8 | Write unsigned 8-bit integer |
| `.cq(a)` | writeInt8 | Write signed 8-bit integer |
| `.Wa(a)` | writeUint16 | Write unsigned 16-bit integer |
| `.Db(a)` | writeInt16 | Write signed 16-bit integer |
| `.B(a)` | writeUint32 | Write unsigned 32-bit integer |
| `.bq(a)` | writeInt32 | Write signed 32-bit integer |
| `.em(a)` | writeFloat32 | Write 32-bit float |
| `.aq(a)` | writeFloat64 | Write 64-bit double |
| `.ee(s,n)` | writeUtf8String | Write UTF-8 string, n=null-terminate |
| `.Eb(s,n)` | writeString | Write ISO-8859-1 string, n=null-terminate |
| `.pj(n)` | writePadding | Write n padding bytes (0xCC/0xDD) |
| `.seek(p)` | seek | Set write position |
| `.S()` | getPosition | Get current position |

## BinaryReader Methods

| Minified | Name |
|----------|------|
| `.getUint8()` | readUint8 |
| `.getUint16()` | readUint16 |
| `.getUint32()` | readUint32 |
| `.getInt8()` | readInt8 |
| `.getInt16()` | readInt16 |
| `.getInt32()` | readInt32 |
| `.getFloat32()` | readFloat |
| `.getFloat64()` | readDouble |
| `.aa(n, w)` | readString(count, isWide) |
| `.Vf()` | readChar |
| `.Qe()` | isAtEnd / isEof |
| `.S()` | getPosition |
| `.seek(p)` | seek |
| `.size()` | getSize |
| `.hf(a)` | alignTo(alignment) |
| `.Uf()` | getArrayBuffer |
| `.Se()` | getByteOrder |
| `.Ue()` | getTextDecoder |

## TlvReader / TlvWriter

| Class | Minified | Name |
|-------|----------|------|
| TlvReader | `.Wf()` | readMbui |
| TlvWriter | `.u(v, n)` | writeMbui(value, byteCount) |
| TlvWriter | `.Mq(v)` | calculateMbuiSize(value) |

## BinaryBuffer

| Minified | Name |
|----------|------|
| `.M` | buffer (ArrayBuffer) |
| `.Qc` | uint8View (Uint8Array) |
| `.Ca` | writePosition |
| `.size()` | getSize |
| `.Hc()` | toArrayBuffer |
| `.oj(b)` | appendByte |
| `.fm(s,o,l)` | appendBytes(src, offset, len) |
| `.hr(n)` | ensureCapacity |
| `.Zi(i,b)` | setByteAt |
| `.Hq(i)` | getByteAt |

## Rectangle (was `I`)

| Minified | Name |
|----------|------|
| `.m` | left |
| `.o` | top |
| `.T` | right |
| `.X` | bottom |
| `.ec` | transform (AffineTransform) |
| `.w()` | getWidth |
| `.v()` | getHeight |
| `.qh()` | getCenter |
| `.clone()` | clone |
| `.size()` | getSize |
| `.ac(dx,dy)` | offset |
| `.Rq(d)` | inflate |
| `.normalize()` | normalize |

## Point (was `w`)

| Minified | Name |
|----------|------|
| `.c` | x |
| `.f` | y |
| `.pe(p)` | subtract → new Point |
| `.Nm(p)` | subtractInPlace |
| `.offset(p)` | addInPlace |
| `.ac(p)` | add → new Point |
| `.clone()` | clone |
| `.kr(s)` | scaleInPlace |
| `.rm(p)` | distanceSquared |

## Size (was `A`)

| Minified | Name |
|----------|------|
| `.O` | width |
| `.Z` | height |
| `.scale(s)` | scale → new Size |

## SessionInfo (was `la`)

| Minified | Name | Description |
|----------|------|-------------|
| `.CommBufferSize` | — | Communication buffer size |
| `.Ja` | isBigEndian | Byte order flag |
| `.se` | deviceSessionId | Protocol session ID from OpenConnection |
| `.Hh` | isDemoMode | Demo mode flag |
| `.bg` | defaultClientId | Default client ID (initially 43981 = 0xABCD) |
| `.L` | externId | Registered client ID (set after RegisterClient) |
| `.fk` | applicationName | Application name string |
| `.Cs` | supportsPost | Supports POST method |

## ProtocolConstants (was `D`)

| Minified | Value | Name |
|----------|-------|------|
| `.R` | 43981 | DEFAULT_CLIENT_ID (0xABCD) |
| `.i` | 0 | DEFAULT_EXTERN_ID |
| `.pa` | 1 | SERVICE_VERSION |
| `.Ia` | 129 | RESPONSE_TAG (0x81) |
| `.b` | 0 | SUCCESS |
| `.A` | 0 | NO_CRYPT |
| `.fa` | 1 | CRYPT_TYPE_1 |

## EventMessage (was `n`)

| Minified | Name | Description |
|----------|------|-------------|
| `.dc` | eventTag | Event type (2=mousedown, 4=mouseup, 16=mousemove, 1=heartbeat) |
| `.Rr` | clientId | Client session ID |
| `.ss` | param1 | Primary parameter (packed x/y for mouse) |
| `.ts` | param2 | Secondary parameter |
| `.zn` | payload | Binary payload buffer (null if none) |
| `.ef` | clipRect | Clip rectangle (null if none) |
| `.Wg` | isSystemEvent | True for internal/ping events |
| `.cb` | metadata | Transform/metadata object |
| `.$a(buf)` | setPayload | Set binary payload |
| `.sc(obj)` | setMetadata | Set transform metadata |
| `.WA()` | markSystemEvent | Set isSystemEvent = true |

## EventType (was `H`)

| Minified | Value | Name |
|----------|-------|------|
| `.A` | 2 | MOUSE_DOWN |
| `.i` | 4 | MOUSE_UP |
| `.b` | 16 | MOUSE_MOVE |
| `.fa` | 521 | DRAG_START |
| `.R` | 529 | DRAG_END |

## PaintData (was `pa`)

| Minified | Name | Description |
|----------|------|-------------|
| `.Jd` | commandCount | Number of paint commands |
| `.bu` | bufferCapacity | Total buffer size |
| `.uk` | continuation | Continuation token (0 = complete) |
| `.op` | dataBuffer | Internal BinaryBuffer |
| `.Jz()` | getAvailableSpace | bufferCapacity - buffer.size() |
| `.je()` | isComplete | continuation === 0 |

## ResponseParser (was `T`)

| Minified | Name | Parses |
|----------|------|--------|
| `.i()` | readOpenConnectionResult | → SessionInfo |
| `.pa()` | readGetMyIpResult | → IP string |
| `.R()` | readRegisterClientResult | → LoginResult |
| `.Ia()` | readIsRegisteredResult | → status (0/1/2/3) |
| `.b(pd)` | readGetPaintDataResult | → PaintData |
| `.fa(f)` | readDeviceSessionResult | → DeviceSessionResult |
| `.A(f,e)` | readDeviceLoginResult | → CryptChallengeResponse |
| `.Pp()` | parsePipeDelimited | → string[] |
| `.Cm(ctx)` | readFileTransferInfo | → file transfer metadata |

## MessageBuilder (was `Ya`)

| Minified | Name | Builds |
|----------|------|--------|
| `.$q(a,b,c)` | buildOpenConnection | PlcAddress, BufferSize, UseLocalHost |
| `.yB(a,b,c,e)` | buildRegisterClient | AppName, ClientName, IP, isDrag |
| `.wB(id)` | buildIsRegisteredClient | externId |
| `.ag(ev)` | buildGetPaintData | With event message |
| `.vB(tok)` | buildContinuation | With continuation token |
| `.Qm(id)` | buildRemoveClient | externId |
| `.qm(u,p,f,c)` | buildDeviceLogin | User, pass, flags, cryptType |
| `.tv(ev)` | buildEventTlv | EventMessage → TLV bytes |
| `.Oa()` | getBuffer | Returns built message buffer |

## GeometryUtil (was `G`)

| Minified | Name | Description |
|----------|------|-------------|
| `.Mc` | TAB_WIDTH (50) | Tab width in pixels |
| `.Lb(r)` | readPoint | Read Point(int16 x, int16 y) |
| `.af(r)` | readPointFloat | Read Point(float32 x, float32 y) |
| `.A(r)` | readRect | Read Rectangle(4× int16) |
| `.Yr(r)` | readRectFloat | Read Rectangle(4× float32) |
| `.ad(r,t)` | readRectTransformed | Read with optional transform |
| `.b(c)` | colorToHex | ARGB → "#rrggbb" |
| `.i(c)` | colorToRgba | ARGB → "rgba(r,g,b,a)" |
| `.fa(d)` | degreesToRadians | Degrees → radians |

## Webvisu (main app)

| Minified | Name | Description |
|----------|------|-------------|
| `.s` | sessionInfo | Current SessionInfo |
| `.ob` | configuration | Current Configuration |
| `.Sa` | eventQueue | Event message output queue |
| `.Va` | canvasRenderer | CanvasRenderer instance |
| `.fb` | visuSession | VisuSessionState |
| `.I(st,ms)` | switchState | Transition to new state with delay |
| `.Ga()` | createTransport | Create new XhrTransport |
| `.Na(si)` | createMessageBuilder | Create MessageBuilder from SessionInfo |
| `.Da()` | getRenderer | Get CanvasRenderer |
| `.U()` | getActiveElement | Get active UI element (dialog or main) |
| `.$b(ev)` | queueEvent | Add event to queue |
| `.ya()` | getTextDecoder | Get text decoder |
| `.Sc` | editControlManager | EditControlManager instance |

## GraphicsState (was `ua`)

| Minified | Name | Description |
|----------|------|-------------|
| `.oi` | fillColor | Current fill color "#rrggbb" |
| `.Ii` | strokeColor | Current stroke color |
| `.Ji` | lineWidth | Current line width |
| `.Ib` | fontString | CSS font string "12px Arial" |
| `.Bg` | fontSize | Font size in pixels |
| `.yf` | hasLineDash | Line dash pattern active |
| `.wf` | gradient | Gradient/pattern object |
| `.la` | context | Canvas 2D context |
| `.EA(c,a)` | setFillColor | Set fill color + alpha |
| `.OA(w,c,s,...)` | setStroke | Set stroke properties |
| `.ZA(f,s,c)` | setFont | Set font string, size, shadow |
| `.TA(x,y)` | setCornerRadius | Set corner radius |
| `.ie()` | hasGradient | Check if gradient active |
| `.wm()` | isFillDisabled | Check if fill disabled |
| `.qj(r)` | applyGradient | Apply gradient to context |

## CanvasRenderer (was `ra`)

| Minified | Name | Description |
|----------|------|-------------|
| `.Y` | offscreenContext | Offscreen canvas 2D context |
| `.Ea` | visibleContext | Visible canvas 2D context |
| `.Cc` | commandCache | CommandCache instance |
| `.Di` | namespaceResolver | NamespaceResolver |
| `.$k` | imageCache | ImageCache |
| `.clear()` | clearCanvas | Clear both canvases |
| `.getContext()` | getActiveContext | Current 2D context |
| `.getState()` | getGraphicsState | Current GraphicsState |
| `.kA()` | switchToVisible | Switch to visible canvas |
| `.lA()` | switchToOffscreen | Switch to offscreen canvas |
| `.Xw(pd)` | parsePaintCommands | Parse binary → command array |
| `.Cq(pd,cb)` | renderPaintCommands | Main render pipeline |
| `.fe()` | getViewport | Get viewport Rectangle |

## State Machine (common interface)

All state classes implement:

| Minified | Name | Description |
|----------|------|-------------|
| `.h()` | execute | Start this state's action |
| `.hb(data)` | onResponse | Handle response data |
| `.H(error)` | onError | Handle error |
| `.className()` | getClassName | Return state name string |
| `.Tf()` | allowsRetry | Whether this state allows retry (default false) |
| `.a` | app | Reference to Webvisu instance |
