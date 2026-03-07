/**
 * jscodeshift AST transform for deobfuscating webvisu.js
 *
 * Renames top-level variable declarations (and all references bound to them)
 * to descriptive names identified during reverse engineering.
 *
 * Only renames identifiers that resolve to the same top-level binding —
 * property accesses like `this.Eb` or `obj.Fb` are NOT touched.
 *
 * Usage:
 *   npx jscodeshift -t deobfuscate-transform.js webvisu-deobfuscated.js
 */

// Symbol mapping: minified name → descriptive name
// Grouped by category for maintainability.
const RENAMES = {
    // =================================================================
    // Protocol core types
    // =================================================================
    Eb: 'FrameHeader',                // Frame header (magic 0xCD55, service group/id, session, content length)
    lb: 'TlvReader',                  // TLV reader (MBUI-encoded tag-length-value)
    mb: 'TlvWriter',                  // TLV writer
    hb: 'BinaryReader_DataView',      // BinaryReader (ArrayBuffer + DataView based)
    ib: 'BinaryReader_StringBased',   // BinaryReader (String-based fallback)
    kb: 'BinaryWriter_StringBased',   // BinaryWriter (String-based fallback)
    O: 'BinaryWriter',               // BinaryWriter (ArrayBuffer-based)
    p: 'BinaryBuffer',               // BinaryBuffer (ArrayBuffer-based)
    ea: 'BinaryBuffer_StringBased',   // BinaryBuffer (String-based fallback)
    J: 'BinaryReader',               // BinaryReader factory/constructor
    n: 'EventMessage',               // Event message (tag, x, y, clientId, extras)
    H: 'EventType',                   // Event type constants (mousedown=2, mouseup=4, mousemove=16)
    Fb: 'EventQueue',                 // Event queue (circular buffer, size 100, deduplication)
    Ya: 'MessageBuilder',             // Message builder (constructs all request types)
    T: 'ResponseParser',              // Response parser (reads all response types)
    Xa: 'XhrTransport',               // XHR communication layer
    Db: 'CommChannel',                // Communication channel
    la: 'SessionInfo',                // Session info (CommBufferSize, byteOrder, sessionId, clientId)
    pa: 'PaintData',                  // PaintData container (commandCount, data buffer, continuation)
    Ja: 'PaintCommandFactory',        // Paint command factory (100+ command types)
    D: 'ProtocolConstants',           // Protocol constants (sessionId sentinels, result codes)
    da: 'UInt64',                     // 64-bit unsigned integer (kb=low32, zb=high32, shift/OR ops)
    gb: 'LowLevelBinaryParser',       // Low-level binary data parsing (doubles, floats, ints)

    // =================================================================
    // Protocol response types
    // =================================================================
    zb: 'CryptChallengeResponse',     // Response with tc, os, ps, qs fields (device login crypto)
    Ab: 'LoginResult',                // Login result with tc (error code) and se (sessionId)
    Bb: 'DeviceSessionResult',        // Device session result with tc, se, Ad (cryptType), Error
    Cb: 'CasChannel',                 // CAS/SAML authentication channel

    // =================================================================
    // Paint command classes
    // =================================================================
    V: 'NoOpPaintCommand',            // No-op / unhandled paint command
    Qb: 'DrawPrimitive',              // ID 1,45,60,61: rect, round-rect, ellipse, lines
    Pb: 'DrawPolygon',                // ID 2,59: filled/stroked polygon, polyline, bezier
    Tb: 'DrawText',                   // ID 3,11,46,47: text rendering variants
    fc: 'SetFillColor',               // ID 4: fill color + fill-enable flag
    gc: 'SetPenStyle',                // ID 5: outline style, color, width
    hc: 'SetFont',                    // ID 6: text color, style, size, family
    Ga: 'ClearRect',                  // ID 7: fill rect with current fill color
    Jb: 'SetClipRect',                // ID 8: push clipping rectangle
    ic: 'RestoreClipRect',            // ID 9: pop clipping rectangle
    ec: 'FillRelatedState',           // ID 10,25: fill-related state
    Ha: 'RectDrawVariant',            // ID 14,15: rect draw variant
    Kb: 'UnknownCmd16',               // ID 16
    Vb: 'UnknownCmd17',               // ID 17
    jc: 'SetDrawMode',                // ID 18: drawing mode / layer switch
    Aa: 'DrawImage',                  // ID 19: bitmap/vector from image pool
    kc: 'UnknownCmd20',               // ID 20
    lc: 'UnknownCmd21_22',            // ID 21,22
    Lb: 'Fill3DRect',                 // ID 23: filled rect with optional 3D border
    mc: 'UnknownCmd24',               // ID 24
    nc: 'AreaGradientStyle',          // ID 30,48: area/gradient style / Set3DStyle
    Sb: 'UnknownCmd31',               // ID 31
    oc: 'UnknownCmd32',               // ID 32
    pc: 'UnknownCmd33_34',            // ID 33,34
    qc: 'UnknownCmd35',               // ID 35
    Nb: 'DrawArc',                    // ID 36: arc / pie segment
    rc: 'InitVisualization',          // ID 37: switch to named visu screen
    Ba: 'UnknownCmd41',               // ID 41
    sc: 'TouchHandlingFlags',         // ID 42: global touch/render flags
    tc: 'TouchRectangles',            // ID 43: hit-test rectangles
    Ob: 'DrawPixels',                 // ID 44: point list
    Ub: 'UnknownCmd12',               // ID 12
    uc: 'UnknownCmd49',               // ID 49
    vc: 'UnknownCmd50',               // ID 50
    wc: 'UnknownCmd51_52',            // ID 51,52
    xc: 'UnknownCmd53',               // ID 53
    yc: 'UnknownCmd54',               // ID 54
    zc: 'UnknownCmd55',               // ID 55
    Ac: 'UnknownCmd56',               // ID 56
    Bc: 'UnknownCmd57',               // ID 57
    Cc: 'UnknownCmd58',               // ID 58
    Dc: 'SetRenderParameter',         // ID 66: numeric key-value pair
    // $b: 'UnknownCmd67',            // $ in identifier — handled by jscodeshift
    Wb: 'UnknownCmd68',               // ID 68
    Zb: 'UnknownCmd69',               // ID 69
    Ec: 'UnknownCmd71',               // ID 71
    Fc: 'UnknownCmd72',               // ID 72
    Gc: 'SetCornerRadius',            // ID 73: corner radius / update element
    Hc: 'UnknownCmd74',               // ID 74
    Ic: 'UnknownCmd75',               // ID 75
    Jc: 'UnknownCmd76',               // ID 76
    Kc: 'UnknownCmd77',               // ID 77
    Lc: 'UnknownCmd78',               // ID 78
    Mc: 'UnknownCmd79',               // ID 79
    Nc: 'UnknownCmd80',               // ID 80
    Oc: 'UnknownCmd81',               // ID 81
    Pc: 'UnknownCmd82',               // ID 82
    Qc: 'UnknownCmd83',               // ID 83
    Rc: 'UnknownCmd85',               // ID 85
    Sc: 'UnknownCmd86',               // ID 86
    Tc: 'UnknownCmd87',               // ID 87
    Uc: 'UnknownCmd88',               // ID 88
    Vc: 'UnknownCmd89',               // ID 89
    Wc: 'UnknownCmd90',               // ID 90
    Xc: 'UnknownCmd91',               // ID 91
    Yc: 'UnknownCmd92',               // ID 92
    Ib: 'ClearRectAndClip',           // ID 93: combined clear + clip
    Zc: 'DrawDomImage',               // ID 94: DOM image for dialog/layer
    Hb: 'ClearFullContext',            // ID 105: clear entire canvas
    hd: 'SetCompositeMode',           // ID 106: canvas composite/blending
    Ea: 'ExtendedCmd8192',             // ID 8192
    Fa: 'ExtendedCmd8193',             // ID 8193
    Da: 'ExtendedCmd8194',             // ID 8194
    ac: 'ExtensionMethodCall',         // ID 27: call method on native extension
    bc: 'NativeControlCreate',         // ID 26: create native control element
    cc: 'NativeControlResize',         // ID 28: resize native control
    dc: 'NativeControlFlags',          // ID 29: set native control visibility/flags
    ad: 'UnknownCmd98',                // ID 98
    bd: 'UnknownCmd99',                // ID 99
    cd: 'UnknownCmd101',               // ID 101
    dd: 'UnknownCmd100',               // ID 100
    ed: 'UnknownCmd102',               // ID 102
    fd: 'UnknownCmd103',               // ID 103
    gd: 'UnknownCmd104',              // ID 104
    md: 'FontTextCommand',             // Base for text commands with font/glyph data
    Rb: 'ShapeRenderer',              // Renders ellipses/rectangles via bezier curves

    // =================================================================
    // State machine classes (connection startup sequence)
    // =================================================================
    fb: 'ErrorState',
    nd: 'CheckDemoModeState',
    od: 'DerivingPostMethodState',
    pd: 'DeviceSessionState',
    qd: 'DeviceLoginState',
    sd: 'VisuRegistrationState',
    td: 'QueryCredentialsState',
    ud: 'RetrieveAutoServerScriptState',
    vd: 'UploadImagePoolState',
    wd: 'RetrievingMyIpState',
    xd: 'StartConnectState',
    yd: 'VisuFileTransferState',
    Fd: 'VisuOnlineState',
    Gd: 'VisuPollingRegistrationState',
    Ad: 'VisuOnlineInitState1',        // Init paint request 1: viewport
    Bd: 'VisuOnlineInitState2',        // Init paint request 2: capabilities (Dd was misidentified, Bd is correct)
    Cd: 'VisuOnlineInitState3',        // Init paint request 3: StartVisu
    Dd: 'VisuOnlineInitState2b',       // Capabilities init (keyboard/touch flags)
    Ed: 'VisuOnlineInitState4',        // Final init
    zd: 'VisuRedundancyInitState',     // Redundancy/failover initialization
    Ta: 'VisuSessionState',            // Session metadata (name, IDs, URL, flags)

    // =================================================================
    // Geometry / primitives
    // =================================================================
    w: 'Point',                        // Point(x, y) — .c = x, .f = y
    A: 'Size',                         // Size(width, height) — .O = width, .Z = height
    I: 'Rectangle',                    // Rectangle(left, top, right, bottom) — .m, .o, .T, .X
    G: 'GeometryUtil',                 // Geometry utility (point reading, rect parsing)
    id: 'AffineTransform',            // 2D affine transform matrix

    // =================================================================
    // Canvas / rendering
    // =================================================================
    ra: 'CanvasRenderer',              // Canvas renderer (manages canvas contexts)
    Ia: 'CommandStreamReader',         // Reads paint command stream
    Ka: 'DoubleBuffer',                // Double-buffer wrapper (two canvas contexts + state)
    ua: 'GraphicsState',               // Canvas graphics state (fill, stroke, font, shadow)
    sa: 'CommandCache',                // Indexed command cache + stack
    wb: 'LayerCanvas',                 // Canvas wrapper for layers (clipping, positioning)
    va: 'NamespaceResolver',           // Resolves qualified names to resource paths
    Qa: 'NoOpCallback',               // Empty function used as placeholder callback
    za: 'DiagnosticsOverlay',          // Debug overlay showing FPS, DPR, canvas size
    Mb: 'HSLColorPalette',            // HSL color conversion + brightness palette
    Ca: 'CookieManager',              // Cookie read/write via document.cookie
    Wa: 'LoadingSpinner',             // Animated loading spinner with rotating petals

    // =================================================================
    // UI element hierarchy
    // =================================================================
    K: 'UIElementFactory',             // Factory for creating client objects, dialogs, embedded elements
    S: 'BaseUIElement',                // Base rendering element (canvas container, borders, pixels)
    P: 'ClientObjectCanvas',           // Standard canvas-based client object (extends S)
    ob: 'NativeUIElement',             // Native browser element wrapper (extends S)
    qb: 'LegacyNativeElement',         // Legacy native plugin element (extends S)
    sb: 'TouchScrollableCanvas',       // Touch-scrollable canvas (extends P)
    ub: 'DialogElement',               // Modal dialog element (extends P, scale/opacity animation)
    rb: 'PageContainer',               // Container for UI pages/layers (array-based)
    vb: 'FloatingPageContainer',       // Modal/floating page container (map-based, extends rb)
    jd: 'InteractiveElement',          // Interactive UI element with hit-test bounds and scroll/zoom state

    // =================================================================
    // Application / configuration
    // =================================================================
    La: 'VersionInfo',                 // Version string "3.5.17.0"
    W: 'ConfigParamSchema',            // Configuration parameter schema (name, URL param, type, parser)
    Va: 'ConfigurationLoader',         // Loads and applies webvisu.cfg.json configuration
    C: 'URLParamUtil',                 // URL query parameter parsing utilities
    t: 'Util',                         // General utilities (time, URL, version parsing, buffer conversion)
    y: 'Logger',                       // Logger (debug, info, warn, trace, error)
    M: 'LogLevel',                     // Log level constants (0=off, 1=fatal, ..., 6=trace)

    // =================================================================
    // Event handling
    // =================================================================
    m: 'ServiceGroupId',               // Service group constants (1-5: connect, getIP, visu, file)
    ca: 'EventMessageFactory',         // Builds EventMessage objects with parameters and binary encoding
    q: 'BrowserUtil',                  // Browser capabilities, point extraction from events, device detection
    na: 'KeyboardHandler',             // Keyboard event handler (keydown/press/up → EventMessage)
    oa: 'PointerHandler',              // Mouse/pointer/touch event handler
    Oa: 'PointerMoveHandler',          // Pointermove/pointerup/pointercancel listener
    Hd: 'TouchEventBridge',            // Browser touch/pointer events → internal event dispatch
    yb: 'WrappedMouseEvent',           // Mouse event wrapper with position and user data
    cb: 'EventNestingTracker',         // Tracks nested event handling depth

    // =================================================================
    // Gesture recognition
    // =================================================================
    X: 'GestureConstants',             // Gesture type/flag/state constants
    Jd: 'GestureData',                 // Gesture state machine data (type, touches, velocity)
    Kd: 'FlickGestureEvent',           // Flick gesture (velocity-based, EventMessage 2051)
    Ld: 'PanGestureEvent',             // Pan/scroll gesture (EventMessage 2050)
    Md: 'PinchGestureEvent',           // Pinch/zoom gesture with rotation (EventMessage 2049)
    Nd: 'TouchGestureEvent',           // Touch-to-mouse or IEC-touch event
    Od: 'TouchPhaseFlags',             // Boolean flags tracking touch phase changes
    Pd: 'TouchEventRecorder',          // Records and replays touch events
    Qd: 'TouchPoint',                  // Individual touch point (id, flags, location)
    Id: 'TouchEventData',              // Collection of touches + timestamp
    Rd: 'TouchLocation',               // Current + previous touch position
    Y: 'TouchEventUtil',               // Touch utility methods (copy, flag checks)
    ab: 'GestureEventHandler',         // Main gesture handler (dispatches to recognizers)
    Td: 'AnimationTimer',              // Deceleration animation timer (setInterval-based)
    Za: 'AnimationConfig',             // Animation parameters (velocity, deceleration, enabled)
    be: 'GestureState',                // Gesture state machine state holder
    ae: 'MinimalGestureState',         // Lightweight final gesture state wrapper
    Zd: 'TouchTracker',                // Tracks active multi-touch positions
    Yd: 'GestureThresholds',           // Flick/pan/click threshold configuration
    Xd: 'BaseGestureRecognizer',       // Base gesture recognizer interface
    Wd: 'GestureRecognizer',           // Full gesture recognizer state machine
    Sd: 'GestureTargetFinder',         // Finds hit-test targets for touch/gesture events
    bb: 'TouchSourceAdapter',          // Converts DOM events to internal TouchPoints
    Q: 'CustomTouchSource',            // Custom touch source adapter variant
    tb: 'GestureTracker',              // Tracks touch gesture position deltas and velocity
    xb: 'ViewportEventDispatcher',     // Manages viewport and delegates event handling

    // =================================================================
    // Gesture/scroll sub-types
    // =================================================================
    R: 'GestureFlags',                 // Gesture capability flags (pan, pinch, flick, touch)
    ce: 'ElementViewportInfo',         // Element viewport info (zoom/scroll state, extra data)
    ee: 'ScrollState',                 // Scroll position, anchor, velocity, bounds
    de: 'ZoomState',                   // Zoom center, scale, rotation, bounds
    fe: 'ScrollBounds',               // Min/max scroll bounds
    ge: 'ZoomBounds',                  // Min/max zoom bounds
    he: 'BaseGestureRenderer',         // Abstract gesture/scroll renderer interface
    Ud: 'EmptyGestureRenderer',        // No-op gesture renderer
    Vd: 'CanvasGestureRenderer',       // Gesture renderer with canvas transform/clip
    kd: 'GlyphMetrics',               // Glyph ID, dimensions, offset

    // =================================================================
    // UI state / element flags
    // =================================================================
    Z: 'ElementStateFlags',            // Numeric flags for UI element states
    nb: 'EdgeFlags',                   // Edge/border flags (right=1, left=2, top=4, bottom=8)
    pb: 'MouseButtonFlags',            // Mouse button state (left=bit0, right=bit1)

    // =================================================================
    // Rendering / visual
    // =================================================================
    E: 'ZIndexLayer',                  // Z-index layer string constants ("2"-"6")
    F: 'VisuConnectionState',          // Connection state constants + error/waiting text
    ma: 'GradientFill',               // Linear gradient renderer with angle and HSV
    qa: 'PaintCommandProcessor',       // Processes individual paint commands to canvas
    wa: 'ImageCache',                  // Image cache with eviction by age
    Gb: 'CachedImage',                // Single cached image (canvas, transparency, load state)

    // =================================================================
    // Protocol state / session
    // =================================================================
    Na: 'TooltipManager',              // Creates and manages tooltip div
    Xb: 'ProtocolDataPacket',          // Parsed TLV packet with identifier and items
    ld: 'PositionCounter',             // Simple two-field position counter
    Yb: 'FileTransferStream',          // File transfer data stream with status tracking
    U: 'TransferStatus',               // Transfer status codes (1-4, 19-20)

    // =================================================================
    // Benchmarking
    // =================================================================
    Sa: 'PerformanceBenchmarker',      // Measures and reports performance metrics
    ie: 'BenchmarkCounter',            // Individual benchmark counter (enabled, start time)

    // =================================================================
    // Misc utilities
    // =================================================================
    ta: 'ClipRegionCollection',        // Manages collection of clip regions
    Ma: 'EditControlManager',          // Text input/edit control lifecycle
    Ua: 'TextPropertySnapshot',        // Text encoding/character code configuration snapshot
    jb: 'CharCodeEncoder',             // Lazy-loaded character code encoder
    eb: 'ConnectionErrorTracker',      // Tracks connection error timestamp and validity
    je: 'ObserverList',                // Observer pattern (subscribe, notify, broadcast)
    ka: 'FontParser',                  // Parses CSS font string to extract size/family
    Pa: 'ElementCollection',           // Observable collection with find/replace/add/remove
    db: 'WindowResizeHandler',         // Listens for window resize and DPI changes
    xa: 'TextWidthCache',              // Caches text width measurements
    ya: 'TextBreakCache',              // Caches text break positions for line wrapping
    rd: 'RSACrypto',                   // RSA-OAEP encryption (import PEM key, encrypt)

    // =================================================================
    // File transfer
    // =================================================================
    Hd: 'TouchEventBridge',            // already defined above — skip duplicate

    // =================================================================
    // $-prefixed identifiers
    // =================================================================
    $b: 'FileTransferCommand',         // Paint command ID 67: initiates file transfer
    $c: 'SetLayerVisibility',          // Paint command ID 96: sets layer visibility mode
    $a: 'GestureProcessor',            // Main multi-touch gesture processor
    $d: 'GesturePhaseHolder',          // Holds current gesture phase/state

    // =================================================================
    // Text encoding globals (set up in IIFE at top of file)
    // =================================================================
    aa: 'WebVisuTextDecoder',          // TextDecoder for ISO-8859-x / windows-1252
    ba: 'WebVisuTextEncoder',          // TextEncoder for ISO-8859-x / windows-1252
    // k: skipped — used as temp variable `var k` in multiple scopes
};

module.exports = function (fileInfo, api) {
    const j = api.jscodeshift;
    const root = j(fileInfo.source);

    // Collect all top-level variable names that we want to rename
    const topLevelBindings = new Set();

    // Find top-level var declarations: `var Eb;` or `var Eb = ...`
    root.find(j.VariableDeclaration).forEach((path) => {
        // Only top-level (Program body or IIFE top-level)
        if (path.parent.node.type === 'Program') {
            path.node.declarations.forEach((decl) => {
                if (decl.id && decl.id.name && RENAMES[decl.id.name]) {
                    topLevelBindings.add(decl.id.name);
                }
            });
        }
    });

    // Also find top-level assignments: `Eb = function(...)` (pattern used after `var Eb;`)
    root.find(j.ExpressionStatement, {
        expression: {
            type: 'AssignmentExpression',
            left: { type: 'Identifier' }
        }
    }).forEach((path) => {
        if (path.parent.node.type === 'Program') {
            const name = path.node.expression.left.name;
            if (RENAMES[name]) {
                topLevelBindings.add(name);
            }
        }
    });

    let totalRenamed = 0;

    // For each top-level binding, rename all Identifier references
    // (but NOT MemberExpression properties like this.Eb or obj.Eb)
    topLevelBindings.forEach((oldName) => {
        const newName = RENAMES[oldName];
        let count = 0;

        root.find(j.Identifier, { name: oldName }).forEach((path) => {
            // Skip property accesses: obj.Eb (where Eb is the property key)
            if (
                path.parent.node.type === 'MemberExpression' &&
                path.parent.node.property === path.node &&
                !path.parent.node.computed
            ) {
                return;
            }

            // Skip object property keys: { Eb: value }
            if (
                path.parent.node.type === 'Property' &&
                path.parent.node.key === path.node &&
                !path.parent.node.computed
            ) {
                return;
            }

            // Skip method definitions
            if (
                path.parent.node.type === 'MethodDefinition' &&
                path.parent.node.key === path.node
            ) {
                return;
            }

            // This is a reference to the top-level binding — rename it
            path.node.name = newName;
            count++;
        });

        if (count > 0) {
            totalRenamed++;
        }
    });

    // =====================================================================
    // Property renames — unique property names on known classes
    // =====================================================================

    // Property names verified as safe for global rename.
    // Each property was checked to have a single meaning across all classes
    // that use it (or consistent meaning across interface implementations).
    const PROPERTY_RENAMES = {
        // =============================================================
        // FrameHeader fields
        // =============================================================
        Hl: 'serviceGroup',
        Il: 'serviceId',
        Fp: 'sessionId',
        Fg: 'headerLength',

        // =============================================================
        // Rectangle fields and methods
        // =============================================================
        m: 'left',                // Rectangle.left (only assigned in Rectangle constructor)
        o: 'top',                 // Rectangle.top
        T: 'right',               // Rectangle.right
        X: 'bottom',              // Rectangle.bottom
        ec: 'transform',          // Rectangle.transform (AffineTransform or null)
        w: 'getWidth',            // Rectangle.getWidth + TextWidthCache.getWidth (same meaning)
        v: 'getHeight',           // Rectangle.getHeight + TextWidthCache.getHeight (same meaning)
        qh: 'getCenter',          // Rectangle.getCenter → Point
        Rq: 'inflate',            // Rectangle.inflate(d)

        // =============================================================
        // Size fields
        // =============================================================
        O: 'width',               // Size.width (only assigned in Size constructor)
        Z: 'height',              // Size.height

        // =============================================================
        // SessionInfo fields
        // =============================================================
        se: 'deviceSessionId',    // Protocol session ID from OpenConnection
        Ja: 'isBigEndian',        // Byte order flag
        Hh: 'isDemoMode',         // Demo mode flag
        bg: 'defaultClientId',    // Default client ID (initially 0xABCD)
        L: 'externId',            // Registered client ID (after RegisterClient)
        fk: 'applicationName',    // Application name string
        Cs: 'supportsPost',       // Supports POST method

        // =============================================================
        // EventMessage fields
        // =============================================================
        dc: 'eventTag',           // Event type ID (2=mousedown, 4=mouseup, 16=mousemove)
        Rr: 'clientId',           // Client/session ID
        ss: 'param1',             // Event parameter 1 (packed coords or key code)
        ts: 'param2',             // Event parameter 2

        // =============================================================
        // PaintData fields
        // =============================================================
        Jd: 'commandCount',       // Number of paint commands
        bu: 'bufferCapacity',     // Size of internal buffer
        uk: 'continuation',       // Continuation token (0 = complete)

        // =============================================================
        // GraphicsState fields
        // =============================================================
        oi: 'fillColor',          // Current fill color string
        Ii: 'strokeColor',        // Current stroke color string
        Ji: 'lineWidth',          // Current line width
        Ib: 'fontString',         // Current CSS font string
        Bg: 'fontSize',           // Current font size in pixels
        Oo: 'fillColorAlpha',     // Fill color has alpha
        Po: 'cornerRadiusX',      // Corner radius X
        Qo: 'cornerRadiusY',      // Corner radius Y
        la: 'context',            // Canvas 2D rendering context
        yf: 'hasLineDash',        // Line dash pattern active
        wf: 'gradient',           // Gradient/pattern object

        // =============================================================
        // CanvasRenderer fields
        // =============================================================
        Y: 'offscreenContext',    // Offscreen canvas 2D context
        Ea: 'visibleContext',     // Visible canvas 2D context (also on DoubleBuffer, same meaning)
        Cc: 'commandCache',       // CommandCache instance
        Di: 'namespaceResolver',  // NamespaceResolver

        // =============================================================
        // Webvisu (main app) fields
        // =============================================================
        s: 'sessionInfo',         // Current SessionInfo (only assigned in Webvisu)
        ob: 'configuration',      // Current Configuration
        Sa: 'eventQueue',         // Event message output queue
        fb: 'visuSession',        // VisuSessionState
        Sc: 'editControlManager', // EditControlManager instance

        // =============================================================
        // BinaryBuffer fields and methods
        // =============================================================
        Qc: 'uint8View',          // Uint8Array view of buffer
        Ca: 'writePosition',      // Current write position
        Hc: 'toArrayBuffer',      // Convert to ArrayBuffer (BinaryBuffer + BinaryBuffer_StringBased + PaintData)
        oj: 'appendByte',         // Append single byte
        fm: 'appendBytes',        // Append byte range (src, offset, len)
        hr: 'ensureCapacity',     // Ensure buffer has capacity
        Zi: 'setByteAt',          // Set byte at index
        Hq: 'getByteAt',          // Get byte at index

        // =============================================================
        // BinaryWriter methods (same on BinaryWriter + BinaryWriter_StringBased)
        // =============================================================
        va: 'writeUint8',         // Write unsigned 8-bit integer
        Wa: 'writeUint16',        // Write unsigned 16-bit integer
        B: 'writeUint32',         // Write unsigned 32-bit integer
        Db: 'writeInt16',         // Write signed 16-bit integer
        ee: 'writeUtf8String',    // Write UTF-8 string
        Eb: 'writeString',        // Write ISO-8859-1 string
        em: 'writeFloat32',       // Write 32-bit float
        aq: 'writeFloat64',       // Write 64-bit double
        bq: 'writeInt32',         // Write signed 32-bit integer
        cq: 'writeInt8',          // Write signed 8-bit integer
        pj: 'writePadding',       // Write padding bytes (0xCC/0xDD alternating)

        // =============================================================
        // BinaryReader methods (same across all reader implementations)
        // =============================================================
        aa: 'readString',         // Read string (count, isWide)
        Vf: 'readChar',           // Read single character
        Qe: 'isEof',              // Check if at end of buffer
        Uf: 'getArrayBuffer',     // Get underlying ArrayBuffer
        Se: 'getByteOrder',       // Get byte order
        Ue: 'getTextDecoder',     // Get text decoder
        S: 'getPosition',         // Get current read/write position (all binary classes)
        hf: 'alignTo',            // Align to boundary (CommandStreamReader)

        // =============================================================
        // TlvReader / TlvWriter methods
        // =============================================================
        Wf: 'readMbui',           // Read MBUI-encoded value
        u: 'writeMbui',           // Write MBUI-encoded value
        Mq: 'calculateMbuiSize',  // Calculate bytes needed for MBUI value

        // =============================================================
        // Point methods (unique to Point)
        // =============================================================
        pe: 'subtract',           // Subtract → new Point
        Nm: 'subtractInPlace',    // Subtract in place
        kr: 'scaleInPlace',       // Scale in place
        rm: 'distanceSquared',    // Distance squared to another point

        // =============================================================
        // ResponseParser unique methods
        // =============================================================
        Pp: 'parsePipeDelimited', // Parse pipe-delimited text response
        Ww: 'readOldDeviceSessionResult',
        Vw: 'readNewDeviceSessionResult',
        cA: 'readNewDeviceCryptResult',
        dA: 'readOldDeviceCryptResult',
        bA: 'readFinishTransferResult',

        // =============================================================
        // MessageBuilder unique methods
        // =============================================================
        tv: 'buildEventTlv',      // Convert EventMessage to TLV binary
    };

    Object.entries(PROPERTY_RENAMES).forEach(([oldProp, newProp]) => {
        root.find(j.MemberExpression, {
            property: { type: 'Identifier', name: oldProp }
        }).forEach((path) => {
            if (!path.node.computed) {
                path.node.property.name = newProp;
            }
        });

        root.find(j.Property, {
            key: { type: 'Identifier', name: oldProp }
        }).forEach((path) => {
            if (!path.node.computed) {
                path.node.key.name = newProp;
            }
        });
    });

    // =====================================================================
    // Class-scoped property renames — only within constructor + prototype
    // =====================================================================
    // These properties have different meanings on different classes, so they
    // can only be safely renamed within the class's own constructor and
    // prototype methods (where `this` is known to be the class instance).

    const CLASS_RENAMES = {
        Point: { c: 'x', f: 'y' },
    };

    Object.entries(CLASS_RENAMES).forEach(([className, propMap]) => {
        // Helper: rename this.oldProp → this.newProp within a function body
        function renameThisProps(fnPath) {
            Object.entries(propMap).forEach(([oldProp, newProp]) => {
                j(fnPath).find(j.MemberExpression, {
                    object: { type: 'ThisExpression' },
                    property: { type: 'Identifier', name: oldProp }
                }).forEach((mePath) => {
                    if (!mePath.node.computed) {
                        mePath.node.property.name = newProp;
                    }
                });
            });
        }

        // 1. Find constructor: `ClassName = function(...) { ... }`
        root.find(j.AssignmentExpression, {
            left: { type: 'Identifier', name: className },
            right: { type: 'FunctionExpression' }
        }).forEach((path) => {
            renameThisProps(path.get('right'));
        });

        // 2. Find prototype: `ClassName.prototype = { ... }`
        root.find(j.AssignmentExpression, {
            left: {
                type: 'MemberExpression',
                object: { type: 'Identifier', name: className },
                property: { type: 'Identifier', name: 'prototype' }
            },
            right: { type: 'ObjectExpression' }
        }).forEach((path) => {
            const protoObj = path.node.right;
            protoObj.properties.forEach((prop) => {
                // Rename this.props inside each prototype method
                if (prop.value && prop.value.type === 'FunctionExpression') {
                    renameThisProps(path.get('right'));
                }
            });
        });
    });

    // PaintCommandFactory.mz → createCommand
    root.find(j.MemberExpression, {
        property: { type: 'Identifier', name: 'mz' }
    }).forEach((path) => {
        if (
            path.node.object.type === 'Identifier' &&
            (path.node.object.name === 'PaintCommandFactory' || path.node.object.name === 'Ja')
        ) {
            path.node.property.name = 'createCommand';
        }
    });

    console.log(`Renamed ${totalRenamed} top-level bindings`);
    return root.toSource({ quote: 'single' });
};
