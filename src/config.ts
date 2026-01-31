export const config = {
  webvisu: {
    url: 'https://192.168.1.10/webvisu/webvisu.htm',
    loadTimeout: 60000,
    canvasRenderDelay: 2000, // Time for canvas to render after element exists

    // Individual delays for each action type (in milliseconds)
    delays: {
      tabClick: 2000,           // After clicking a tab
      dropdownOpen: 300,        // After clicking dropdown arrow to open
      dropdownScroll: 300,      // After dragging scrollbar
      dropdownSelect: 300,      // After clicking an item to select
      toggleButton: 300,       // After clicking Ohjaus button
      statusRead: 500,          // Before reading status indicator
    },
  },
  server: {
    port: parseInt(process.env.PORT || '8080', 10),
  },
  browser: {
    headless: process.env.HEADLESS !== 'false',
    viewport: { width: 1280, height: 768 },
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
  // Coordinates based on screenshot analysis of 4-light-switches.png and 4-light-switch-selection.png
  lightSwitches: {
    // TOP dropdown to select light switch (showing "Eteinen 2")
    // This is the FIRST dropdown at the top of the black panel
    dropdown: { x: 275, y: 103 },
    // Dropdown arrow button (small triangle on right side of top dropdown)
    dropdownArrow: { x: 523, y: 139 },
    // "Ohjaus" (Control) button for first function - gray button below the top dropdown
    ohjausButton: { x: 290, y: 170 },
    // Second "Ohjaus" button for dual-function switches (below the first one)
    ohjausButton2: { x: 290, y: 240 },
    // Status indicator position for first function (the circular icon)
    statusIndicator: { x: 505, y: 204 },
    // Status indicator position for second function (below the first indicator)
    statusIndicator2: { x: 505, y: 274 },
    // Dropdown list configuration (when top dropdown is open)
    dropdownList: {
      // Position of first visible item "0" in open dropdown
      firstItemY: 132,
      // Height of each item
      itemHeight: 29,
      // Number of items visible at once in dropdown (0, Kylpyhuone 1, Kylpyhuone 2, WC alakerta 1, WC alakerta 2)
      visibleItems: 5,
      // X position for clicking items (center of dropdown list)
      itemX: 275,
    },
    // Scrollbar for dropdown (when open) - on right edge of dropdown list
    scrollbar: {
      // Scrollbar thumb starting position (top of track where thumb rests initially)
      thumbStart: { x: 528, y: 172 },
      // Scrollbar track boundaries for dragging
      track: {
        x: 528,
        topY: 175,      // Top of scrollable track area
        bottomY: 285,   // Bottom of scrollable track area
      },
    },
  },
};

// All 56 light switches in dropdown order (0-indexed)
// ID format: lowercase with hyphens for URL-safe API access
export const lightSwitchList = [
  { id: '0', name: '0', firstPress: '', index: 0 },
  { id: 'kylpyhuone-1', name: 'Kylpyhuone 1', firstPress: 'Kylpyhuone alakerta', index: 1 },
  { id: 'kylpyhuone-2', name: 'Kylpyhuone 2', firstPress: 'Sauna laude LED', secondPress: 'Sauna siivousvalo', index: 2 },
  { id: 'wc-alakerta-1', name: 'WC alakerta 1', firstPress: 'WC alakerta kattovalo', index: 3 },
  { id: 'wc-alakerta-2', name: 'WC alakerta 2', firstPress: 'WC alakerta peili', index: 4 },
  { id: 'khh-1', name: 'KHH 1', firstPress: 'Kodinhoitohuone LED', index: 5 },
  { id: 'khh-2', name: 'KHH 2', firstPress: 'Kodinhoitohuone kattovalo', index: 6 },
  { id: 'keittio-1', name: 'Keittiö 1', firstPress: 'Terassi ulkovalo', index: 7 },
  { id: 'keittio-2', name: 'Keittiö 2', firstPress: 'Sisäänkäynti', secondPress: 'Autokatos', index: 8 },
  { id: 'tuulikaappi-1', name: 'Tuulikaappi 1', firstPress: 'Sisäänkäynti', secondPress: 'Autokatos', index: 9 },
  { id: 'tuulikaappi-2', name: 'Tuulikaappi 2', firstPress: 'Tuulikaappi', secondPress: 'Eteinen', index: 10 },
  { id: 'mh-alakerta-1', name: 'MH alakerta 1', firstPress: 'Makuuhuone alakerta kattovalo', index: 11 },
  { id: 'mh-alakerta-2', name: 'MH alakerta 2', firstPress: 'Makuuhuone alakerta ikkunavalo', index: 12 },
  { id: 'eteinen-1', name: 'Eteinen 1', firstPress: 'Eteinen aula', index: 13 },
  { id: 'eteinen-2', name: 'Eteinen 2', firstPress: 'Eteinen tuulikaappi', index: 14 },
  { id: 'khh-vaatehuone', name: 'KHH vaatehuone', firstPress: 'Kodinhoitohuone vaatehuone', index: 15 },
  { id: 'tuulikaappi-vaatehuone', name: 'Tuulikaappi vaatehuone', firstPress: 'Eteinen vaatehuone', index: 16 },
  { id: 'porras-ak-1', name: 'Porras AK 1', firstPress: 'Portaikon valot', index: 17 },
  { id: 'porras-ak-2', name: 'Porras AK 2', firstPress: 'Yläkerta aula kattovalo', index: 18 },
  { id: 'mh-1-1', name: 'MH 1/1', firstPress: 'Aikuisten makuuhuone kattovalo', index: 19 },
  { id: 'mh-1-2', name: 'MH 1/2', firstPress: 'Aikuisten makuuhuone ikkunavalo', index: 20 },
  { id: 'mh-1-vaatehuone', firstPress: 'Aikuisten makuuhuone', name: 'Aikuisten makuuhuone vaatehuone', index: 21 },
  { id: '22', name: '22', firstPress: '', index: 22 },
  { id: 'kylpyhuone-yk-1', name: 'Kylpyhuone YK 1', firstPress: 'Kylpyhuone yläkerta kattovalo', index: 23 },
  { id: 'kylpyhuone-yk-2', name: 'Kylpyhuone YK 2', firstPress: 'Kylpyhuone yläkerta peilivalo', index: 24 },
  { id: 'porras-yk-1', name: 'Porras YK 1', firstPress: 'Yläkerran aula rappuset', index: 25 },
  { id: 'porras-yk-2', name: 'Porras YK 2', firstPress: 'Portaikon valot', index: 26 },
  { id: 'aula-yk-1', name: 'Aula YK 1', firstPress: 'Yläkerran aula LED', index: 27 },
  { id: 'aula-yk-2', name: 'Aula YK 2', firstPress: 'Yläkerran aula katovalo', index: 28 },
  { id: 'mh2-1', name: 'MH2/1', firstPress: 'Makuuhuone yläkerta kattovalo Aarni', index: 29 },
  { id: 'mh2-2', name: 'MH2/2', firstPress: 'Makuuhuone yläkerta ikkunavalo Aarni', secondPress: 'Yläkerta aula ikkunavalo', index: 30 },
  { id: 'mh3-1', name: 'MH3/1', firstPress: 'Makuuhuone yläkerta kattovalo Seela', index: 31 },
  { id: 'mh3-2', name: 'MH3/2', firstPress: 'Makuuhuone yläkerta ikkunavalo Seela', index: 32 },
  { id: 'tekninen-tila', name: 'Tekninen tila', firstPress: 'Tekninen tila', index: 33 },
  { id: 'kellari-wc', name: 'Kellari WC', firstPress: 'Kellari WC', index: 34 },
  { id: 'kellari-eteinen-1', name: 'Kellari eteinen 1', firstPress: 'Kellari varasto', index: 35 },
  { id: 'kellari-eteinen-2', name: 'Kellari eteinen 2', firstPress: 'Kellari varasto', index: 36 },
  { id: 'kellari-1', name: 'Kellari 1', firstPress: 'Kellari takaosa', secondPress: 'Kellari etuosa', index: 37 },
  { id: 'kellari-2', name: 'Kellari 2', firstPress: 'Kellari biljardipöytä', index: 38 },
  { id: '39', name: '39', firstPress: '', index: 39 },
  { id: '40', name: '40', firstPress: '', index: 40 },
  { id: 'saareke-1', name: 'Saareke 1', firstPress: 'Olohuone kattovalo 1', secondPress: 'Olohuone kattovalo 2', index: 41 },
  { id: 'saareke-2', name: 'Saareke 2', firstPress: 'Olohuone LED', index: 42 },
  { id: 'saareke-3', name: 'Saareke 3', firstPress: 'Olohuone ikkuna', index: 43 },
  { id: 'saareke-4', name: 'Saareke 4', firstPress: 'Ruokailu ikkuna', secondPress: 'Keittiö ikkunavalo', index: 44 },
  { id: 'saareke-5', name: 'Saareke 5', firstPress: 'Keittiö LED', index: 45 },
  { id: 'saareke-6', name: 'Saareke 6', firstPress: 'Keittiö kaapisto ala', index: 46 },
  { id: 'saareke-7', name: 'Saareke 7', firstPress: 'Keittiö kattovalo', index: 47 },
  { id: 'saareke-8', name: 'Saareke 8', firstPress: 'Ruokailu', index: 48 },
  { id: 'autokatos-1', name: 'Autokatos 1', firstPress: 'Sisäänkäynti', index: 49 },
  { id: 'autokatos-2', name: 'Autokatos 2', firstPress: 'Autokatos', index: 50 },
  { id: 'ulkovarasto', name: 'Ulkovarasto', firstPress: 'Ulkovarasto', index: 51 },
  { id: '52', name: '52', firstPress: '', index: 52 },
  { id: '53', name: '53', firstPress: '', index: 53 },
  { id: '54', name: '54', firstPress: '', index: 54 },
  { id: '55', name: '55', firstPress: '', index: 55 },
  { id: '56', name: '56', firstPress: '', index: 56 },
];

// Lookup maps for quick access
export const lightSwitches: Record<string, number> = Object.fromEntries(
  lightSwitchList.map(s => [s.id, s.index])
);

export const lightSwitchNames: Record<number, string> = Object.fromEntries(
  lightSwitchList.map(s => [s.index, s.name])
);

export const lightSwitchById: Record<string, typeof lightSwitchList[0]> = Object.fromEntries(
  lightSwitchList.map(s => [s.id, s])
);
