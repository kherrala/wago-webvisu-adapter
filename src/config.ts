export const config = {
  webvisu: {
    url: 'https://192.168.1.10/webvisu/webvisu.htm',
    loadTimeout: 60000,
    canvasRenderDelay: 2000, // Time for canvas to render after element exists

    // Individual delays for each action type (in milliseconds)
    delays: {
      tabClick: 2000,           // After clicking a tab
      dropdownOpen: 2000,       // After clicking dropdown arrow to open
      dropdownScrollStart: 100, // After dragging scrollbar
      dropdownScrollDrag: 300,  // After dragging scrollbar
      dropdownScrollStop: 800,  // After dragging scrollbar
      dropdownSelect: 400,      // After clicking an item to select
      toggleButton: 0,          // After clicking Ohjaus button
      statusRead: 0,            // Before reading status indicator
    },
  },
  server: {
    port: parseInt(process.env.PORT || '8080', 10),
  },
  browser: {
    headless: process.env.HEADLESS !== 'false',
    viewport: { width: 1280, height: 1024 },
  },
  database: {
    path: process.env.DB_PATH || './data/lights.db',
  },
  polling: {
    enabled: process.env.POLLING_ENABLED !== 'false',
    cycleDelayMs: parseInt(process.env.POLL_CYCLE_DELAY_MS || '30000', 10),
  },
  protocol: {
    host: process.env.PROTOCOL_HOST || '192.168.1.10',
    port: parseInt(process.env.PROTOCOL_PORT || '443', 10),
    requestTimeout: parseInt(process.env.PROTOCOL_TIMEOUT || '5000', 10),
    initialRenderTimeoutMs: parseInt(process.env.PROTOCOL_INITIAL_RENDER_TIMEOUT_MS || '7000', 10),
    initialRenderPollIntervalMs: parseInt(process.env.PROTOCOL_INITIAL_RENDER_POLL_INTERVAL_MS || '0', 10),
    dropdownPreOpenDelayMs: parseInt(process.env.PROTOCOL_DROPDOWN_PRE_OPEN_DELAY_MS || '0', 10),
    dropdownOpenTimeoutMs: parseInt(process.env.PROTOCOL_DROPDOWN_OPEN_TIMEOUT_MS || '6000', 10),
    dropdownOpenPollIntervalMs: parseInt(process.env.PROTOCOL_DROPDOWN_OPEN_POLL_INTERVAL_MS || '0', 10),
    dropdownScrollTimeoutMs: parseInt(process.env.PROTOCOL_DROPDOWN_SCROLL_TIMEOUT_MS || '5000', 10),
    dropdownScrollPollIntervalMs: parseInt(process.env.PROTOCOL_DROPDOWN_SCROLL_POLL_INTERVAL_MS || '0', 10),
    dropdownItemClickYOffset: parseInt(process.env.PROTOCOL_DROPDOWN_ITEM_CLICK_Y_OFFSET || '2', 10),
    scrollApproach: (process.env.PROTOCOL_SCROLL_APPROACH || 'arrow') as 'drag' | 'arrow',
    scrollSettleDelayMs: parseInt(process.env.PROTOCOL_SCROLL_SETTLE_DELAY_MS || '0', 10),
    dragStartHoldMs: parseInt(process.env.PROTOCOL_DRAG_START_HOLD_MS || '60', 10),
    dragStepDelayMs: parseInt(process.env.PROTOCOL_DRAG_STEP_DELAY_MS || '45', 10),
    dragEndHoldMs: parseInt(process.env.PROTOCOL_DRAG_END_HOLD_MS || '50', 10),
    selectionSettleDelayMs: parseInt(process.env.PROTOCOL_SELECTION_SETTLE_DELAY_MS || '200', 10),
    selectionVerifyTimeoutMs: parseInt(process.env.PROTOCOL_SELECTION_VERIFY_TIMEOUT_MS || '0', 10),
    selectionVerifyPollIntervalMs: parseInt(process.env.PROTOCOL_SELECTION_VERIFY_POLL_INTERVAL_MS || '0', 10),
    maxSelectionAttempts: parseInt(process.env.PROTOCOL_MAX_SELECTION_ATTEMPTS || '5', 10),
    togglePreClickDelayMs: parseInt(process.env.PROTOCOL_TOGGLE_PRE_CLICK_DELAY_MS || '0', 10),
    togglePressHoldMs: parseInt(process.env.PROTOCOL_TOGGLE_PRESS_HOLD_MS || '140', 10),
    togglePostClickDelayMs: parseInt(process.env.PROTOCOL_TOGGLE_POST_CLICK_DELAY_MS || '0', 10),
    togglePostRenderPolls: parseInt(process.env.PROTOCOL_TOGGLE_POST_RENDER_POLLS || '2', 10),
    togglePostRenderPollDelayMs: parseInt(process.env.PROTOCOL_TOGGLE_POST_RENDER_POLL_DELAY_MS || '0', 10),
    statusPollDelayMs: parseInt(process.env.PROTOCOL_STATUS_POLL_DELAY_MS || '0', 10),
    statusMaxAttempts: parseInt(process.env.PROTOCOL_STATUS_MAX_ATTEMPTS || '3', 10),
    strictPaintValidation: process.env.PROTOCOL_STRICT_PAINT_VALIDATION !== 'false',
    renderSettleMinEmptyPolls: parseInt(process.env.PROTOCOL_RENDER_SETTLE_MIN_EMPTY_POLLS || '2', 10),
    renderSettleMaxPolls: parseInt(process.env.PROTOCOL_RENDER_SETTLE_MAX_POLLS || '8', 10),
    renderSettlePollIntervalMs: parseInt(process.env.PROTOCOL_RENDER_SETTLE_POLL_INTERVAL_MS || '80', 10),
    renderSettleHashStreak: parseInt(process.env.PROTOCOL_RENDER_SETTLE_HASH_STREAK || '0', 10),
    renderSettleTimeoutMs: parseInt(process.env.PROTOCOL_RENDER_SETTLE_TIMEOUT_MS || '0', 10),
    reconnectDelay: 5000,
    postClickDelay: 60,
    postSelectDelay: 100,
    debugHttp: process.env.PROTOCOL_DEBUG_HTTP === 'true',
    sessionTraceEnabled: process.env.PROTOCOL_SESSION_TRACE === 'true',
    sessionTraceDir: process.env.PROTOCOL_SESSION_TRACE_DIR || '/data/protocol-trace',
    logRawFrameData: process.env.PROTOCOL_LOG_RAW_FRAME_DATA === 'true',
    debugRenderEnabled: process.env.PROTOCOL_DEBUG_RENDER === 'true',
    debugRenderDir: process.env.PROTOCOL_DEBUG_RENDER_DIR || '/data/protocol-render-debug',
    debugRenderMaxFrames: parseInt(process.env.PROTOCOL_DEBUG_RENDER_MAX_FRAMES || '400', 10),
    debugRenderMinIntervalMs: parseInt(process.env.PROTOCOL_DEBUG_RENDER_MIN_INTERVAL_MS || '0', 10),
    debugRenderIncludeEmptyFrames: process.env.PROTOCOL_DEBUG_RENDER_INCLUDE_EMPTY !== 'false',
    debugRenderFetchImages: process.env.PROTOCOL_DEBUG_RENDER_FETCH_IMAGES !== 'false',
    debugRenderImageFetchTimeoutMs: parseInt(process.env.PROTOCOL_DEBUG_RENDER_IMAGE_FETCH_TIMEOUT_MS || '1200', 10),
    postDataInHeader: (process.env.PROTOCOL_POST_DATA_IN_HEADER as 'auto' | 'always' | 'never') || 'auto',
    deviceUsername: process.env.PROTOCOL_DEVICE_USERNAME || '',
    devicePassword: process.env.PROTOCOL_DEVICE_PASSWORD || '',
  },
};

// UI coordinate mapping based on screenshot analysis
// These coordinates are relative to the canvas element
export const uiCoordinates = {
  // Tab navigation (top bar)
  tabs: {
    autokatos: { x: 70, y: 11 },      // Garage
    ulkopistorasia: { x: 200, y: 11 }, // Outdoor outlet
    lisatoiminnot: { x: 350, y: 11 },  // Extra functions
    napit: { x: 520, y: 11 },          // Buttons/Light switches
    lammitys: { x: 630, y: 11 },       // Heating
    hvac: { x: 780, y: 11 },           // HVAC
  },

  // Light switches tab (Napit)
  lightSwitches: {
    dropdown: { x: 275, y: 103 },
    dropdownArrow: { x: 523, y: 139 },
    ohjausButton: { x: 290, y: 170 },
    statusIndicator: { x: 505, y: 204 },
    statusIndicator2: { x: 505, y: 235 },
    statusIndicator3: { x: 75, y: 291 },
    dropdownList: {
      firstItemY: 153,
      itemHeight: 30,
      visibleItems: 5,
      itemX: 290,
    },
    keypadEscButton: { x: 714, y: 583 },
    scrollbar: {
      x: 528,
      arrowUp: { x: 527, y: 162 },
      arrowDown: { x: 527, y: 295 },
      scanRange: { topY: 170, bottomY: 286 },
      thumbRange: { topY: 174, bottomY: 282 },
    },
  },
};

// ─── Physical lights catalog ──────────────────────────────────────────────────
// Each entry represents a physical light or circuit that can be switched on/off.
// Multiple switches (or first/second press of one switch) may control the same light.
export const lightList = [
  { id: 'kylpyhuone',                 name: 'Kylpyhuone' },
  { id: 'sauna-laude-ledi',           name: 'Saunan laude ledi' },
  { id: 'sauna-siivousvalo',          name: 'Sauna siivousvalo' },
  { id: 'wc-alakerta-katto',          name: 'WC Alakerta katto' },
  { id: 'wc-alakerta-peili',          name: 'WC Alakerta peili' },
  { id: 'khh-ledi',                   name: 'Kodinhoitohuone ledi' },
  { id: 'khh-katto',                  name: 'Kodinhoitohuone kattovalo' },
  { id: 'terassi-ulkovalo',           name: 'Terassi ulkovalo' },
  { id: 'varasto-ulkovalo',           name: 'Varasto ulkovalo' },
  { id: 'sisaankaynti',              name: 'Sisäänkäynti' },
  { id: 'autokatos',                  name: 'Autokatos' },
  { id: 'tuulikaappi-valo',           name: 'Tuulikaappi' },
  { id: 'eteinen-valo',               name: 'Eteinen' },
  { id: 'mh-alakerta-katto',          name: 'MH alakerta kattovalo' },
  { id: 'mh-alakerta-ikkuna',         name: 'MH alakerta ikkuna' },
  { id: 'khh-vaatehuone-valo',        name: 'Kodinhoitohuone vaatehuone' },
  { id: 'tuulikaappi-vaatehuone-valo',name: 'Tuulikaappi vaatehuone' },
  { id: 'portaikko',                  name: 'Portaikko' },
  { id: 'ylakerta-aula-katto',        name: 'Yläkerta aula kattovalo' },
  { id: 'aikuisten-katto',            name: 'Aikuisten kattovalo',   plcLabel: 'Essi Kattovalo' },
  { id: 'aikuisten-ikkuna',           name: 'Aikuisten ikkunavalo',  plcLabel: 'Essi ikkunavalo' },
  { id: 'aikuisten-vaatehuone',       name: 'Aikuisten vaatehuone',  plcLabel: 'Essi Vaatehuone' },
  { id: 'kylpyhuone-yk-katto',        name: 'Kylpyhuone yläkerta katto' },
  { id: 'kylpyhuone-yk-peili',        name: 'Kylpyhuone yk peilivalo' },
  { id: 'ylakerta-aula-ledi',         name: 'Yläkerta aula ledi' },
  { id: 'aarni-katto',                name: 'Aarni kattovalo',       plcLabel: 'Onni Kattovalo' },
  { id: 'aarni-ikkuna',               name: 'Aarni ikkunavalo',      plcLabel: 'Onni ikkunavalo' },
  { id: 'aula-ikkuna',                name: 'Aula ikkunvalo' },
  { id: 'seela-katto',                name: 'Seela kattovalo',       plcLabel: 'Aatu Kattovalo' },
  { id: 'seela-ikkuna',               name: 'Seela ikkunavalo',      plcLabel: 'Aatu ikkunavalo' },
  { id: 'tekninen-tila',              name: 'Tekninen tila' },
  { id: 'wc-kellari',                 name: 'WC Kellari' },
  { id: 'kellari-varasto',            name: 'Kellari varasto' },
  { id: 'kellari-takaosa',            name: 'Kellari takaosa' },
  { id: 'kellari-etuosa',             name: 'Kellari etuosa' },
  { id: 'biljardipoyta',              name: 'Biljardipöytä' },
  { id: 'olohuone-katto',             name: 'Olohuone kattovalo' },
  { id: 'olohuone-takka',             name: 'Olohuone takka' },
  { id: 'olohuone-ledi',              name: 'Olohuone ledi' },
  { id: 'olohuone-ikkuna',            name: 'Olohuone ikkuna' },
  { id: 'ruokailu-ikkuna',            name: 'Ruokailu ikkuna' },
  { id: 'keittio-ikkuna',             name: 'Keittiö ikkunavalo' },
  { id: 'keittio-katto',              name: 'Keittiö katto' },
  { id: 'keittio-kaapisto-ala',       name: 'Keittiö kaapisto ala' },
  { id: 'keittio-kattovalo',          name: 'Keittiö Kattovalo' },
  { id: 'ruokailu',                   name: 'Ruokailu' },
  { id: 'varasto',                    name: 'Varasto' },
];

export const lightById: Record<string, typeof lightList[0]> = Object.fromEntries(
  lightList.map(l => [l.id, l])
);

// ─── Switch catalog ───────────────────────────────────────────────────────────
// All 57 switches in PLC dropdown order (0-indexed).
//
// Fields:
//   id              — URL-safe identifier used in the REST API
//   name            — Display name in the REST API
//   plcLabel        — Exact PLC dropdown label (only set when different from name)
//   firstPressLightId  — Light ID (from lightList) controlled by the first press
//   secondPressLightId — Light ID controlled by the second press (dual-function only)
//   index           — 0-based position in the PLC dropdown
export const lightSwitchList = [
  { id: '0',                         name: '0',                                index: 0 },
  { id: 'kylpyhuone-1',              name: 'Kylpyhuone 1',                     firstPressLightId: 'kylpyhuone',                  index: 1 },
  { id: 'kylpyhuone-2',              name: 'Kylpyhuone 2',                     firstPressLightId: 'sauna-laude-ledi',             secondPressLightId: 'sauna-siivousvalo',          index: 2 },
  { id: 'wc-alakerta-1',             name: 'WC alakerta 1',                    firstPressLightId: 'wc-alakerta-katto',            index: 3 },
  { id: 'wc-alakerta-2',             name: 'WC alakerta 2',                    firstPressLightId: 'wc-alakerta-peili',            index: 4 },
  { id: 'khh-1',                     name: 'KHH 1',                            firstPressLightId: 'khh-ledi',                    index: 5 },
  { id: 'khh-2',                     name: 'KHH 2',                            firstPressLightId: 'khh-katto',                 index: 6 },
  { id: 'keittio-1',                 name: 'Keittiö 1',                        firstPressLightId: 'terassi-ulkovalo',             secondPressLightId: 'varasto-ulkovalo',           index: 7 },
  { id: 'keittio-2',                 name: 'Keittiö 2',                        firstPressLightId: 'sisaankaynti',               secondPressLightId: 'autokatos',                  index: 8 },
  { id: 'tuulikaappi-1',             name: 'Tuulikaappi 1',                    firstPressLightId: 'sisaankaynti',               secondPressLightId: 'autokatos',                  index: 9 },
  { id: 'tuulikaappi-2',             name: 'Tuulikaappi 2',                    firstPressLightId: 'tuulikaappi-valo',             secondPressLightId: 'eteinen-valo',               index: 10 },
  { id: 'mh-alakerta-1',             name: 'MH alakerta 1',                    firstPressLightId: 'mh-alakerta-katto',            index: 11 },
  { id: 'mh-alakerta-2',             name: 'MH alakerta 2',                    firstPressLightId: 'mh-alakerta-ikkuna',           index: 12 },
  { id: 'eteinen-1',                 name: 'Eteinen 1',                        firstPressLightId: 'eteinen-valo',                index: 13 },
  { id: 'eteinen-2',                 name: 'Eteinen 2',                        firstPressLightId: 'tuulikaappi-valo',             index: 14 },
  { id: 'khh-vaatehuone',            name: 'KHH vaatehuone',                   firstPressLightId: 'khh-vaatehuone-valo',          index: 15 },
  { id: 'tuulikaappi-vaatehuone',    name: 'Tuulikaappi vaatehuone',           firstPressLightId: 'tuulikaappi-vaatehuone-valo',  index: 16 },
  { id: 'porras-ak-1',               name: 'Porras AK 1',                      firstPressLightId: 'portaikko',                   index: 17 },
  { id: 'porras-ak-2',               name: 'Porras AK 2',                      firstPressLightId: 'ylakerta-aula-katto',          index: 18 },
  { id: 'mh-1-1',                    name: 'MH 1/1',                           firstPressLightId: 'aikuisten-katto',             plcLabel: 'Essi Kattovalo',                       index: 19 },
  { id: 'mh-1-2',                    name: 'MH 1/2',                           firstPressLightId: 'aikuisten-ikkuna',            plcLabel: 'Essi ikkunavalo',                      index: 20 },
  { id: 'mh-1-vaatehuone',           name: 'Aikuisten makuuhuone vaatehuone',  firstPressLightId: 'aikuisten-vaatehuone',         plcLabel: 'Essi Vaatehuone',                      index: 21 },
  { id: '22',                        name: '22',                               index: 22 },
  { id: 'kylpyhuone-yk-1',           name: 'Kylpyhuone YK 1',                  firstPressLightId: 'kylpyhuone-yk-katto',          index: 23 },
  { id: 'kylpyhuone-yk-2',           name: 'Kylpyhuone YK 2',                  firstPressLightId: 'kylpyhuone-yk-peili',          index: 24 },
  { id: 'porras-yk-1',               name: 'Porras YK 1',                      firstPressLightId: 'ylakerta-aula-katto',          secondPressLightId: 'ylakerta-aula-ledi',         index: 25 },
  { id: 'porras-yk-2',               name: 'Porras YK 2',                      firstPressLightId: 'portaikko',                   index: 26 },
  { id: 'aula-yk-1',                 name: 'Aula YK 1',                        firstPressLightId: 'ylakerta-aula-ledi',           index: 27 },
  { id: 'aula-yk-2',                 name: 'Aula YK 2',                        firstPressLightId: 'ylakerta-aula-katto',          index: 28 },
  { id: 'mh2-1',                     name: 'MH2/1',                            firstPressLightId: 'aarni-katto',                 plcLabel: 'Onni Kattovalo',                       index: 29 },
  { id: 'mh2-2',                     name: 'MH2/2',                            firstPressLightId: 'aarni-ikkuna',                secondPressLightId: 'aula-ikkuna',                plcLabel: 'Onni ikkunavalo',                      index: 30 },
  { id: 'mh3-1',                     name: 'MH3/1',                            firstPressLightId: 'seela-katto',                 plcLabel: 'Aatu Kattovalo',                       index: 31 },
  { id: 'mh3-2',                     name: 'MH3/2',                            firstPressLightId: 'seela-ikkuna',                plcLabel: 'Aatu ikkunavalo',                      index: 32 },
  { id: 'tekninen-tila',             name: 'Tekninen tila',                    firstPressLightId: 'tekninen-tila',               index: 33 },
  { id: 'kellari-wc',                name: 'Kellari WC',                       firstPressLightId: 'wc-kellari',                  index: 34 },
  { id: 'kellari-eteinen-1',         name: 'Kellari eteinen 1',                firstPressLightId: 'kellari-varasto',             index: 35 },
  { id: 'kellari-eteinen-2',         name: 'Kellari eteinen 2',                firstPressLightId: 'kellari-varasto',             index: 36 },
  { id: 'kellari-1',                 name: 'Kellari 1',                        firstPressLightId: 'kellari-takaosa',             secondPressLightId: 'kellari-etuosa',             index: 37 },
  { id: 'kellari-2',                 name: 'Kellari 2',                        firstPressLightId: 'biljardipoyta',               index: 38 },
  { id: '39',                        name: '39',                               index: 39 },
  { id: '40',                        name: '40',                               index: 40 },
  { id: 'saareke-1',                 name: 'Saareke 1',                        firstPressLightId: 'olohuone-katto',              secondPressLightId: 'khh-katto',                       index: 41 },
  { id: 'saareke-2',                 name: 'Saareke 2',                        firstPressLightId: 'olohuone-ledi',               index: 42 },
  { id: 'saareke-3',                 name: 'Saareke 3',                        firstPressLightId: 'olohuone-ikkuna',             index: 43 },
  { id: 'saareke-4',                 name: 'Saareke 4',                        firstPressLightId: 'ruokailu-ikkuna',             secondPressLightId: 'keittio-ikkuna',             index: 44 },
  { id: 'saareke-5',                 name: 'Saareke 5',                        firstPressLightId: 'keittio-katto',               index: 45 },
  { id: 'saareke-6',                 name: 'Saareke 6',                        firstPressLightId: 'keittio-kaapisto-ala',        index: 46 },
  { id: 'saareke-7',                 name: 'Saareke 7',                        firstPressLightId: 'keittio-kattovalo',           index: 47 },
  { id: 'saareke-8',                 name: 'Saareke 8',                        firstPressLightId: 'ruokailu',                    index: 48 },
  { id: 'autokatos-1',               name: 'Autokatos 1',                      firstPressLightId: 'sisaankaynti',               index: 49 },
  { id: 'autokatos-2',               name: 'Autokatos 2',                      firstPressLightId: 'autokatos',                   index: 50 },
  { id: 'ulkovarasto',               name: 'Ulkovarasto',                      firstPressLightId: 'varasto',                     index: 51 },
  { id: '52',                        name: '52',                               index: 52 },
  { id: '53',                        name: '53',                               index: 53 },
  { id: '54',                        name: '54',                               index: 54 },
  { id: '55',                        name: '55',                               index: 55 },
  { id: '56',                        name: '56',                               index: 56 },
];

// Lookup maps for quick access
export const lightSwitches: Record<string, number> = Object.fromEntries(
  lightSwitchList.map(s => [s.id, s.index])
);

export const lightSwitchNames: Record<number, string> = Object.fromEntries(
  lightSwitchList.map(s => [s.index, s.name])
);

// Maps PLC dropdown index → exact text shown in the PLC dropdown/header.
// Falls back to name when no plcLabel is set (they match for most entries).
export const lightSwitchPlcLabels: Record<number, string> = Object.fromEntries(
  lightSwitchList.map(s => [s.index, (s as { plcLabel?: string }).plcLabel ?? s.name])
);

export const lightSwitchById: Record<string, typeof lightSwitchList[0]> = Object.fromEntries(
  lightSwitchList.map(s => [s.id, s])
);

// Maps light ID → primary {switchId, functionNumber} for queries and toggles.
// First-press controllers are preferred over second-press for the same light
// (reading indicator1 is simpler than indicator2).
export const lightPrimaryController: Record<string, { switchId: string; functionNumber: 1 | 2 }> = {};
// Pass 1: firstPress controllers
for (const sw of lightSwitchList) {
  const fpId = (sw as { firstPressLightId?: string }).firstPressLightId;
  if (fpId && !lightPrimaryController[fpId]) {
    lightPrimaryController[fpId] = { switchId: sw.id, functionNumber: 1 };
  }
}
// Pass 2: secondPress controllers (fallback where no firstPress controller found)
for (const sw of lightSwitchList) {
  const spId = (sw as { secondPressLightId?: string }).secondPressLightId;
  if (spId && !lightPrimaryController[spId]) {
    lightPrimaryController[spId] = { switchId: sw.id, functionNumber: 2 };
  }
}

// Maps light ID → all {switchId, functionNumber} pairs that control it.
export const lightAllControllers: Record<string, Array<{ switchId: string; functionNumber: 1 | 2 }>> = {};
for (const sw of lightSwitchList) {
  const fpId = (sw as { firstPressLightId?: string }).firstPressLightId;
  const spId = (sw as { secondPressLightId?: string }).secondPressLightId;
  if (fpId) {
    (lightAllControllers[fpId] ??= []).push({ switchId: sw.id, functionNumber: 1 });
  }
  if (spId) {
    (lightAllControllers[spId] ??= []).push({ switchId: sw.id, functionNumber: 2 });
  }
}

// ─── Floor data ───────────────────────────────────────────────────────────────
// Floor level per switch dropdown index (0 = basement, 1 = ground, 2 = upper).
// Entries with no floor data (outdoor switches, unused slots) are omitted.
const lightSwitchFloors: Record<number, 0 | 1 | 2> = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1,
  11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1, 17: 1, 18: 2,
  19: 2, 20: 2, 21: 2,
  23: 2, 24: 2, 25: 2, 26: 1, 27: 2, 28: 2,
  29: 2, 30: 2, 31: 2, 32: 2,
  33: 1,
  34: 0, 35: 0, 36: 0, 37: 0, 38: 0,
  41: 1, 42: 1, 43: 1, 44: 1, 45: 1, 46: 1, 47: 1, 48: 1,
};

// Maps light ID → floor level via primary controller switch.
// Outdoor/unclassified lights are explicitly excluded so they appear
// as "Muut tilat" (floor=null) in the API and Grafana dashboard.
const outdoorLightIds = new Set([
  'terassi-ulkovalo', 'varasto-ulkovalo', 'sisaankaynti', 'autokatos', 'varasto',
]);
export const lightFloorMap: Record<string, 0 | 1 | 2> = {};
for (const [lightId, { switchId }] of Object.entries(lightPrimaryController)) {
  if (outdoorLightIds.has(lightId)) continue;
  const sw = lightSwitchById[switchId];
  if (sw) {
    const floor = lightSwitchFloors[sw.index];
    if (floor !== undefined) {
      lightFloorMap[lightId] = floor;
    }
  }
}
