// Paint frame classifier — scores incoming paint frames for 10 UI events
// using simple pattern matching on command counts, text labels, images, and polygons.
// Purely additive: does not replace existing detection logic.

import { inflateSync } from 'zlib';
import {
  PaintCommand,
  parsePaintCommands,
  extractTextLabels,
  extractDrawImages,
  extractPolygons,
  extractCornerRadii,
} from './paint-commands';
import {
  CMD_INIT_VISUALIZATION,
  CMD_TOUCH_HANDLING_FLAGS,
  CMD_SET_CLIP_RECT,
  CMD_RESTORE_CLIP_RECT,
  CMD_LAYER_SWITCH,
} from './command-ids';
import { extractDropdownLabels } from '../model/dropdown-labels';
import { extractDropdownHeaderLabel } from '../model/header-verification';
import { normalizeVisuText } from '../model/text-utils';
import { isLampStatusImageId } from '../model/lamp-ids';
import { uiCoordinates } from '../config';

export interface PreviousFrameState {
  headerLabel: string | null;
  dropdownItems: string[];
}

export interface FrameClassification {
  commandCount: number;
  textLabelCount: number;
  imageCount: number;

  // Event probabilities (0.0 - 1.0)
  initialPageLoad: number;
  fullPageRender: number;
  napitTabLoaded: number;
  dropdownOpen: number;
  dropdownClosed: number;
  dropdownScrolled: number;
  headerChanged: number;
  minimalUpdate: number;
  emptyFrame: number;
  lampStatusVisible: number;

  // Extracted data for downstream consumers
  headerLabel: string | null;
  dropdownItems: string[];
  tabLabels: string[];
}

const NAPIT_NORMALIZED_LABELS = [
  'ohjaus',
  'tallennaasetukset',
  'lueasetukset',
  '1.painallus',
  '2.painallus',
];

// Command IDs allowed in minimal (clip-only) frames
const MINIMAL_CMD_IDS = new Set([CMD_LAYER_SWITCH, CMD_SET_CLIP_RECT, CMD_RESTORE_CLIP_RECT]);

export function classifyFrame(
  commands: PaintCommand[],
  previous?: PreviousFrameState,
): FrameClassification {
  // --- Empty frame ---
  if (commands.length === 0) {
    return {
      commandCount: 0,
      textLabelCount: 0,
      imageCount: 0,
      initialPageLoad: 0,
      fullPageRender: 0,
      napitTabLoaded: 0,
      dropdownOpen: 0,
      dropdownClosed: 0,
      dropdownScrolled: 0,
      headerChanged: 0,
      minimalUpdate: 0,
      emptyFrame: 1.0,
      lampStatusVisible: 0,
      headerLabel: null,
      dropdownItems: [],
      tabLabels: [],
    };
  }

  // --- Single pass: count command IDs and check for init/touch flags ---
  let hasInitVisu = false;
  let hasTouchFlags = false;
  let allMinimal = true;

  for (const cmd of commands) {
    if (cmd.id === CMD_INIT_VISUALIZATION) hasInitVisu = true;
    if (cmd.id === CMD_TOUCH_HANDLING_FLAGS) hasTouchFlags = true;
    if (!MINIMAL_CMD_IDS.has(cmd.id)) allMinimal = false;
  }

  // --- Extract signals ---
  const textLabels = extractTextLabels(commands);
  const images = extractDrawImages(commands);
  const dropdownLabels = extractDropdownLabels(commands);
  const polygons = extractPolygons(commands);
  const cornerRadii = extractCornerRadii(commands);

  const textLabelCount = textLabels.length;
  const imageCount = images.length;
  const lampImages = images.filter(img => isLampStatusImageId(img.imageId));
  const lampCount = lampImages.length;

  // Tab labels: Y ≤ 24 (top bar)
  const tabLabels = textLabels
    .filter(l => l.top <= 24)
    .map(l => l.text);

  // Header label (reuse existing extraction)
  const headerLabel = extractDropdownHeaderLabel(commands);

  // Dropdown items as sorted text list
  const dropdownItems = dropdownLabels
    .map(l => l.text)
    .sort();

  // Distinct dropdown rows
  const distinctRows = new Set(dropdownLabels.map(l => l.row));

  // Normalized text set for Napit check
  const normalizedTexts = new Set(textLabels.map(l => normalizeVisuText(l.text)));

  // Check "ohjaus" presence
  const hasOhjaus = normalizedTexts.has('ohjaus');

  // --- Score each event ---

  // initialPageLoad
  let initialPageLoad = 0;
  if (hasInitVisu && hasTouchFlags) initialPageLoad = 1.0;
  else if (hasInitVisu) initialPageLoad = 0.8;

  // minimalUpdate
  let minimalUpdate = 0;
  if (
    commands.length >= 1 &&
    commands.length <= 8 &&
    allMinimal &&
    textLabelCount === 0 &&
    imageCount === 0 &&
    polygons.length === 0 &&
    cornerRadii.length === 0
  ) {
    minimalUpdate = 1.0;
  }

  // fullPageRender
  let fullPageRender = 0;
  if (textLabelCount >= 40) fullPageRender += 0.4;
  if (textLabelCount >= 50) fullPageRender += 0.2;
  if (imageCount >= 20) fullPageRender += 0.2;
  if (tabLabels.length >= 4) fullPageRender += 0.2;
  if (initialPageLoad >= 0.8) fullPageRender *= 0.5;

  // napitTabLoaded
  let napitTabLoaded = 0;
  const napitLabelMatches = NAPIT_NORMALIZED_LABELS.filter(req => normalizedTexts.has(req));
  if (napitLabelMatches.length === NAPIT_NORMALIZED_LABELS.length) napitTabLoaded += 0.5;
  if (lampCount >= 3) napitTabLoaded += 0.3;
  if (hasOhjaus) napitTabLoaded += 0.1;
  if (headerLabel !== null) napitTabLoaded += 0.1;

  // dropdownOpen
  let dropdownOpen = 0;
  if (dropdownLabels.length >= 3) dropdownOpen += 0.4;
  if (distinctRows.size >= 3) dropdownOpen += 0.2;
  if (polygons.length >= 4) dropdownOpen += 0.2;
  if (cornerRadii.length >= 1) dropdownOpen += 0.1;
  if (textLabelCount >= 15 && textLabelCount <= 30) dropdownOpen += 0.1;

  // dropdownClosed
  let dropdownClosed = 0;
  if (hasOhjaus && dropdownLabels.length < 3) dropdownClosed += 0.6;
  if (hasOhjaus && polygons.length === 0) dropdownClosed += 0.2;
  if (hasOhjaus && dropdownLabels.length === 0) dropdownClosed += 0.2;
  if (dropdownOpen >= 0.6) dropdownClosed = Math.min(dropdownClosed, 0.2);

  // dropdownScrolled (requires previous)
  let dropdownScrolled = 0;
  if (previous && previous.dropdownItems.length > 0 && dropdownItems.length >= 3) {
    const prevSorted = [...previous.dropdownItems].sort();
    const currSorted = dropdownItems;
    const differs = prevSorted.length !== currSorted.length ||
      prevSorted.some((item, i) => item !== currSorted[i]);
    dropdownScrolled = differs ? 1.0 : 0.0;
  }

  // headerChanged (requires previous)
  let headerChanged = 0;
  if (previous && previous.headerLabel !== null && headerLabel !== null) {
    const prevNorm = normalizeVisuText(previous.headerLabel);
    const currNorm = normalizeVisuText(headerLabel);
    headerChanged = prevNorm !== currNorm ? 1.0 : 0.0;
  }

  // lampStatusVisible
  let lampStatusVisible = Math.min(1.0, lampCount * 0.3);
  // Round to avoid floating point noise (0.3 * 3 = 0.8999...)
  lampStatusVisible = Math.round(lampStatusVisible * 10) / 10;

  return {
    commandCount: commands.length,
    textLabelCount,
    imageCount,
    initialPageLoad,
    fullPageRender: clamp(fullPageRender),
    napitTabLoaded: clamp(napitTabLoaded),
    dropdownOpen: clamp(dropdownOpen),
    dropdownClosed: clamp(dropdownClosed),
    dropdownScrolled,
    headerChanged,
    minimalUpdate,
    emptyFrame: 0,
    lampStatusVisible: clamp(lampStatusVisible),
    headerLabel,
    dropdownItems,
    tabLabels,
  };
}

function clamp(v: number): number {
  return Math.min(1.0, Math.max(0.0, v));
}

/**
 * Decompress a `paintCommandsRaw` value from a trace log entry
 * back into PaintCommand[]. The stored format is deflate-compressed,
 * base64-encoded raw paint command bytes.
 */
export function decompressTraceCommands(paintCommandsRaw: string): PaintCommand[] {
  const compressed = Buffer.from(paintCommandsRaw, 'base64');
  const raw = inflateSync(compressed);
  return parsePaintCommands(new Uint8Array(raw));
}
