// Paint command stream parser focused on status color extraction

import { BinaryReader } from './binary';
import {
  CMD_DRAW_POLYGON,
  CMD_DRAW_PRIMITIVE,
  CMD_SET_FILL_COLOR,
  CMD_SET_PEN_STYLE,
  CMD_SET_FONT,
  CMD_FILL_3D_RECT,
  CMD_CLEAR_RECT,
  CMD_SET_CLIP_RECT,
  CMD_RESTORE_CLIP_RECT,
  CMD_LAYER_SWITCH,
  CMD_DRAW_IMAGE,
  CMD_SET_AREA_STYLE,
  CMD_SET_AREA_STYLE_LEGACY,
  CMD_SET_RENDER_PARAMETER,
  CMD_SET_CORNER_RADIUS,
  CMD_TOUCH_HANDLING_FLAGS,
  CMD_TOUCH_RECTANGLES,
  CMD_DRAW_TEXT,
  CMD_DRAW_TEXT_UTF16,
} from './command-ids';

export {
  CMD_DRAW_POLYGON,
  CMD_DRAW_PRIMITIVE,
  CMD_SET_FILL_COLOR,
  CMD_SET_PEN_STYLE,
  CMD_SET_FONT,
  CMD_FILL_3D_RECT,
  CMD_CLEAR_RECT,
  CMD_SET_CLIP_RECT,
  CMD_RESTORE_CLIP_RECT,
  CMD_LAYER_SWITCH,
  CMD_DRAW_IMAGE,
  CMD_SET_AREA_STYLE,
  CMD_SET_AREA_STYLE_LEGACY,
  CMD_SET_RENDER_PARAMETER,
  CMD_SET_CORNER_RADIUS,
  CMD_TOUCH_HANDLING_FLAGS,
  CMD_TOUCH_RECTANGLES,
  CMD_DRAW_TEXT,
  CMD_DRAW_TEXT_UTF16,
};

export interface PaintCommand {
  id: number;
  size: number;
  data: Uint8Array;
}

export interface ColorCommand {
  commandId: number;
  argb: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface RectCommand {
  commandId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor?: { r: number; g: number; b: number; a: number };
}

export interface ImageDrawCommand {
  commandId: number;
  imageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  flags: number;
  tintColor: { r: number; g: number; b: number; a: number };
}

export interface TextLabelCommand {
  commandId: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  flags: number;
  text: string;
}

export interface TouchHandlingFlagsCommand {
  commandId: number;
  flags: number;
  touchHandlingActive: boolean;
  semiTransparencyActive: boolean;
  clipFeedbackEnabled: boolean;
}

export interface TouchRectSubTarget {
  id: number;
  layerId: number;
  lockScrollX: boolean;
  lockScrollY: boolean;
  offsetX: number;
  offsetY: number;
}

export interface TouchRectangleCommand {
  commandId: number;
  touchId: number;
  flags: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  scrollLimits?: { minX: number; minY: number; maxX: number; maxY: number };
  zoomLimits?: { min: number; max: number };
  subTargets: TouchRectSubTarget[];
}

function isTouchRectanglesCommand(cmd: PaintCommand): boolean {
  if (cmd.id === CMD_TOUCH_RECTANGLES) {
    return true;
  }
  // Some WebVisu variants emit touch rectangles on command 42 instead of 43.
  // Command 42 with 4-byte payload is handled as touch flags.
  return cmd.id === CMD_TOUCH_HANDLING_FLAGS && cmd.data.length > 4;
}

export function parsePaintCommands(data: Uint8Array): PaintCommand[] {
  const commands: PaintCommand[] = [];
  const reader = new BinaryReader(data);

  while (reader.remaining >= 8) {
    const size = reader.readUint32();
    if (size < 8) break;

    const id = reader.readUint32();
    const dataSize = size - 8;

    if (reader.remaining < dataSize) break;

    const cmdData = new Uint8Array(reader.readBytes(dataSize));
    commands.push({ id, size, data: cmdData });
  }

  return commands;
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function decodeUtf16Le(bytes: Uint8Array): string {
  if (bytes.length < 2) {
    return '';
  }
  const alignedLength = bytes.length - (bytes.length % 2);
  return Buffer.from(bytes.subarray(0, alignedLength)).toString('utf16le');
}

export function extractColorCommands(commands: PaintCommand[]): ColorCommand[] {
  const colors: ColorCommand[] = [];

  for (const cmd of commands) {
    if (cmd.id === CMD_SET_FILL_COLOR && cmd.data.length >= 4) {
      const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
      // SetFillColor format: flags(4) + argb(4). ARGB is at offset 4 when 8+ bytes present;
      // fall back to offset 0 for legacy 4-byte payloads.
      const argb = cmd.data.length >= 8 ? dv.getUint32(4, true) : dv.getUint32(0, true);
      colors.push({
        commandId: cmd.id,
        argb,
        a: (argb >>> 24) & 0xFF,
        r: (argb >>> 16) & 0xFF,
        g: (argb >>> 8) & 0xFF,
        b: argb & 0xFF,
      });
    }
  }

  return colors;
}

export function extractRectCommands(commands: PaintCommand[]): RectCommand[] {
  const rects: RectCommand[] = [];

  for (const cmd of commands) {
    if (cmd.id === CMD_FILL_3D_RECT && cmd.data.length >= 8) {
      const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
      // Fill3DRect: x(2), y(2), width(2), height(2), then fill color(4), highlight(4), shadow(4)
      const x = dv.getInt16(0, true);
      const y = dv.getInt16(2, true);
      const width = dv.getInt16(4, true);
      const height = dv.getInt16(6, true);

      let fillColor: RectCommand['fillColor'] | undefined;
      if (cmd.data.length >= 12) {
        const argb = dv.getUint32(8, true);
        fillColor = {
          a: (argb >>> 24) & 0xFF,
          r: (argb >>> 16) & 0xFF,
          g: (argb >>> 8) & 0xFF,
          b: argb & 0xFF,
        };
      }

      rects.push({ commandId: cmd.id, x, y, width, height, fillColor });
    }
  }

  return rects;
}

export interface StatusRegion {
  x: number;
  y: number;
  tolerance: number; // How far from the center to look for color commands
}

function overlapsRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  region: StatusRegion
): boolean {
  return (
    x <= region.x + region.tolerance &&
    y <= region.y + region.tolerance &&
    x + width >= region.x - region.tolerance &&
    y + height >= region.y - region.tolerance
  );
}

function parseDrawImageCommand(cmd: PaintCommand): ImageDrawCommand | null {
  const reader = new BinaryReader(cmd.data);
  if (reader.remaining < 2) return null;

  const namespaceLen = reader.readUint16();
  if (reader.remaining < namespaceLen + 2) return null;
  const namespace = reader.readString(namespaceLen);
  // CoDeSys aligns string fields to 2-byte boundaries.
  if (namespaceLen % 2 === 1 && reader.remaining > 0) reader.skip(1);

  const nameLen = reader.readUint16();
  if (reader.remaining < nameLen + 16 + 8) return null;
  const name = reader.readString(nameLen);
  // Align to 2-byte boundary after name string.
  if (nameLen % 2 === 1 && reader.remaining > 0) reader.skip(1);
  const imageId = namespace.length > 0 ? `${namespace}.${name}` : name;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < 4; i++) {
    if (reader.remaining < 4) return null;
    const px = reader.readInt16();
    const py = reader.readInt16();
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }

  if (reader.remaining < 8) return null;
  const flags = reader.readUint32();
  const tintArgb = reader.readUint32();

  return {
    commandId: cmd.id,
    imageId,
    x: Number.isFinite(minX) ? minX : 0,
    y: Number.isFinite(minY) ? minY : 0,
    width: Number.isFinite(maxX - minX) ? Math.max(1, maxX - minX) : 1,
    height: Number.isFinite(maxY - minY) ? Math.max(1, maxY - minY) : 1,
    flags,
    tintColor: {
      a: (tintArgb >>> 24) & 0xFF,
      r: (tintArgb >>> 16) & 0xFF,
      g: (tintArgb >>> 8) & 0xFF,
      b: tintArgb & 0xFF,
    },
  };
}

export function extractDrawImages(commands: PaintCommand[]): ImageDrawCommand[] {
  const images: ImageDrawCommand[] = [];
  for (const cmd of commands) {
    if (cmd.id !== CMD_DRAW_IMAGE) continue;
    const parsed = parseDrawImageCommand(cmd);
    if (!parsed) continue;
    images.push(parsed);
  }
  return images;
}

function parseTextLabelCommand(cmd: PaintCommand): TextLabelCommand | null {
  if ((cmd.id !== CMD_DRAW_TEXT && cmd.id !== CMD_DRAW_TEXT_UTF16) || cmd.data.length < 14) return null;
  const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
  const left = dv.getInt16(0, true);
  const top = dv.getInt16(2, true);
  const right = dv.getInt16(4, true);
  const bottom = dv.getInt16(6, true);
  const flags = dv.getUint32(8, true);
  const textLen = dv.getUint16(12, true);
  const textOffset = 14;
  const available = cmd.data.length - textOffset;
  if (available <= 0) return null;

  let text = '';
  if (cmd.id === CMD_DRAW_TEXT_UTF16) {
    // WebVisu UTF-16 command stores character count, but some variants emit byte count.
    const byteLength = textLen * 2 <= available ? textLen * 2 : Math.min(textLen, available);
    if (byteLength <= 0) return null;
    text = decodeUtf16Le(cmd.data.subarray(textOffset, textOffset + byteLength)).replace(/\x00+$/g, '');
  } else {
    if (textLen > available) return null;
    text = decodeLatin1(cmd.data.subarray(textOffset, textOffset + textLen)).replace(/\x00+$/g, '');
  }

  return {
    commandId: cmd.id,
    left,
    top,
    right,
    bottom,
    flags,
    text,
  };
}

export function extractTextLabels(commands: PaintCommand[]): TextLabelCommand[] {
  const labels: TextLabelCommand[] = [];
  for (const cmd of commands) {
    const parsed = parseTextLabelCommand(cmd);
    if (!parsed) continue;
    labels.push(parsed);
  }
  return labels;
}

export interface PenStyleCommand {
  commandId: number;
  lineStyle: number;
  strokeEnabled: boolean;
  lineWidth: number;
  argb: number;
  color: { r: number; g: number; b: number; a: number };
  lineCap: 'butt' | 'square' | 'round';
  lineJoin: 'miter' | 'bevel' | 'round';
  miterLimit: number;
  dashPattern: number[] | null;
}

export function extractPenStyles(commands: PaintCommand[]): PenStyleCommand[] {
  const out: PenStyleCommand[] = [];
  const dashPatternMap: Record<number, number[] | null> = {
    0: null,
    1: [8, 3],
    2: [3, 3],
    3: [8, 3, 3, 3],
    4: [8, 3, 3, 3, 3, 3],
  };
  for (const cmd of commands) {
    if (cmd.id !== CMD_SET_PEN_STYLE || cmd.data.length < 10) continue;
    const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
    const lineStyle = dv.getUint32(0, true);
    const argb = dv.getUint32(4, true);
    const lineWidth = Math.max(1, dv.getUint16(8, true));
    let lineCap: PenStyleCommand['lineCap'] = 'butt';
    let lineJoin: PenStyleCommand['lineJoin'] = 'miter';
    let miterLimit = 1.7 * lineWidth;
    if (cmd.data.length >= 16) {
      const capBits = dv.getUint16(10, true);
      const joinBits = dv.getUint16(12, true);
      const miterRaw = dv.getUint16(14, true);
      if ((capBits & 0x2) !== 0) lineCap = 'round';
      else if ((capBits & 0x1) !== 0) lineCap = 'square';
      if ((joinBits & 0x2) !== 0) lineJoin = 'round';
      else if ((joinBits & 0x1) !== 0) lineJoin = 'bevel';
      miterLimit = miterRaw === 1 ? 1.7 * lineWidth : Math.max(1, 2 * miterRaw);
    }
    out.push({
      commandId: cmd.id,
      lineStyle,
      strokeEnabled: lineStyle !== 5,
      lineWidth,
      argb,
      color: {
        a: (argb >>> 24) & 0xFF,
        r: (argb >>> 16) & 0xFF,
        g: (argb >>> 8) & 0xFF,
        b: argb & 0xFF,
      },
      lineCap,
      lineJoin,
      miterLimit,
      dashPattern: dashPatternMap[lineStyle] ?? null,
    });
  }
  return out;
}

export interface FontCommand {
  commandId: number;
  argb: number;
  size: number;
  styleFlags: number;
  family: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
}

export function extractFonts(commands: PaintCommand[]): FontCommand[] {
  const out: FontCommand[] = [];
  for (const cmd of commands) {
    if (cmd.id !== CMD_SET_FONT || cmd.data.length < 12) continue;
    const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
    const argb = dv.getUint32(0, true);
    const styleFlags = dv.getUint32(4, true);
    const size = dv.getUint16(8, true);
    const familyLength = dv.getUint16(10, true);
    if (cmd.data.length < 12 + familyLength) continue;
    const family = decodeLatin1(cmd.data.subarray(12, 12 + familyLength)).replace(/\x00+$/g, '');
    out.push({
      commandId: cmd.id,
      argb,
      size,
      styleFlags,
      family,
      bold: (styleFlags & 0x2) !== 0,
      italic: (styleFlags & 0x1) !== 0,
      underline: (styleFlags & 0x4) !== 0,
      strikeout: (styleFlags & 0x8) !== 0,
    });
  }
  return out;
}

export interface PrimitiveCommandInfo {
  commandId: number;
  kind: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function parseRectFromTwoPoints(
  data: Uint8Array,
  offset: number
): { left: number; top: number; right: number; bottom: number; width: number; height: number } | null {
  if (data.length < offset + 8) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const x1 = dv.getInt16(offset, true);
  const y1 = dv.getInt16(offset + 2, true);
  const x2 = dv.getInt16(offset + 4, true);
  const y2 = dv.getInt16(offset + 6, true);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return {
    left,
    top,
    right,
    bottom,
    width: (right - left) + 1,
    height: (bottom - top) + 1,
  };
}

export function extractPrimitives(commands: PaintCommand[]): PrimitiveCommandInfo[] {
  const out: PrimitiveCommandInfo[] = [];
  for (const cmd of commands) {
    if (cmd.id !== CMD_DRAW_PRIMITIVE || cmd.data.length < 10) continue;
    const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
    const kind = dv.getUint16(0, true);
    const rect = parseRectFromTwoPoints(cmd.data, 2);
    if (!rect) continue;
    out.push({
      commandId: cmd.id,
      kind,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    });
  }
  return out;
}

export interface PolygonCommandInfo {
  commandId: number;
  mode: number;
  pointCount: number;
}

export function extractPolygons(commands: PaintCommand[]): PolygonCommandInfo[] {
  const out: PolygonCommandInfo[] = [];
  for (const cmd of commands) {
    if (cmd.id !== CMD_DRAW_POLYGON || cmd.data.length < 4) continue;
    const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
    out.push({
      commandId: cmd.id,
      mode: dv.getUint16(0, true),
      pointCount: dv.getUint16(2, true),
    });
  }
  return out;
}

export interface ClipCommandInfo {
  commandId: number;
  type: 'set' | 'restore';
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function extractClipCommands(commands: PaintCommand[]): ClipCommandInfo[] {
  const out: ClipCommandInfo[] = [];
  for (const cmd of commands) {
    if (cmd.id !== CMD_SET_CLIP_RECT && cmd.id !== CMD_RESTORE_CLIP_RECT) continue;
    const rect = parseRectFromTwoPoints(cmd.data, 0);
    if (!rect) continue;
    out.push({
      commandId: cmd.id,
      type: cmd.id === CMD_SET_CLIP_RECT ? 'set' : 'restore',
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    });
  }
  return out;
}

export interface LayerSwitchCommand {
  commandId: number;
  drawToVisibleLayer: boolean;
}

export function extractLayerSwitches(commands: PaintCommand[]): LayerSwitchCommand[] {
  const out: LayerSwitchCommand[] = [];
  for (const cmd of commands) {
    if (cmd.id !== CMD_LAYER_SWITCH || cmd.data.length < 2) continue;
    const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
    out.push({
      commandId: cmd.id,
      drawToVisibleLayer: dv.getUint16(0, true) === 1,
    });
  }
  return out;
}

export interface AreaStyleCommandInfo {
  commandId: number;
  fillDisabled: boolean;
  borderArgb: number;
  fillArgb: number;
}

export function extractAreaStyles(commands: PaintCommand[]): AreaStyleCommandInfo[] {
  const out: AreaStyleCommandInfo[] = [];
  for (const cmd of commands) {
    if ((cmd.id !== CMD_SET_AREA_STYLE && cmd.id !== CMD_SET_AREA_STYLE_LEGACY) || cmd.data.length < 12) continue;
    const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
    out.push({
      commandId: cmd.id,
      fillDisabled: dv.getUint32(0, true) === 1,
      borderArgb: dv.getUint32(4, true),
      fillArgb: dv.getUint32(8, true),
    });
  }
  return out;
}

export interface RenderParameterCommandInfo {
  commandId: number;
  parameterId: number;
  value: number;
}

export function extractRenderParameters(commands: PaintCommand[]): RenderParameterCommandInfo[] {
  const out: RenderParameterCommandInfo[] = [];
  for (const cmd of commands) {
    if (cmd.id !== CMD_SET_RENDER_PARAMETER || cmd.data.length < 8) continue;
    const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
    out.push({
      commandId: cmd.id,
      parameterId: dv.getUint16(0, true),
      value: dv.getInt32(4, true),
    });
  }
  return out;
}

export interface CornerRadiusCommandInfo {
  commandId: number;
  radiusX: number;
  radiusY: number;
}

export function extractCornerRadii(commands: PaintCommand[]): CornerRadiusCommandInfo[] {
  const out: CornerRadiusCommandInfo[] = [];
  for (const cmd of commands) {
    if (cmd.id !== CMD_SET_CORNER_RADIUS || cmd.data.length < 4) continue;
    const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
    out.push({
      commandId: cmd.id,
      radiusX: dv.getInt16(0, true),
      radiusY: dv.getInt16(2, true),
    });
  }
  return out;
}

export function extractTouchHandlingFlags(commands: PaintCommand[]): TouchHandlingFlagsCommand[] {
  const flags: TouchHandlingFlagsCommand[] = [];
  for (const cmd of commands) {
    if (cmd.id !== CMD_TOUCH_HANDLING_FLAGS || cmd.data.length !== 4) continue;
    const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
    const rawFlags = dv.getUint32(0, true);
    flags.push({
      commandId: cmd.id,
      flags: rawFlags,
      touchHandlingActive: (rawFlags & 0x1) !== 0,
      semiTransparencyActive: (rawFlags & 0x2) !== 0,
      clipFeedbackEnabled: (rawFlags & 0x4) !== 0,
    });
  }
  return flags;
}

function normalizeTouchRectFromPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { left: number; top: number; right: number; bottom: number } {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  // webvisu.js decrements bottom-right by one after rectangle normalization.
  const right = Math.max(left, Math.max(x1, x2) - 1);
  const bottom = Math.max(top, Math.max(y1, y2) - 1);
  return { left, top, right, bottom };
}

function parseTouchRectanglesCommand(cmd: PaintCommand): TouchRectangleCommand[] {
  if (!isTouchRectanglesCommand(cmd) || cmd.data.length < 12) {
    return [];
  }

  const reader = new BinaryReader(cmd.data);
  const touchRects: TouchRectangleCommand[] = [];
  let currentTouchRect: TouchRectangleCommand | null = null;

  while (reader.remaining >= 8) {
    const descriptor = reader.readUint32();

    if ((descriptor & 0x80000000) !== 0) {
      const touchId = reader.readUint32();
      if (reader.remaining < 8) break;

      const x1 = reader.readInt16();
      const y1 = reader.readInt16();
      const x2 = reader.readInt16();
      const y2 = reader.readInt16();
      const rect = normalizeTouchRectFromPoints(x1, y1, x2, y2);

      currentTouchRect = {
        commandId: cmd.id,
        touchId,
        flags: descriptor & 0x7fffffff,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        subTargets: [],
      };
      touchRects.push(currentTouchRect);
      continue;
    }

    const payloadLen = descriptor & 0xffff;
    const propertyType = (descriptor & 0x7fffffff) >>> 16;
    if (reader.remaining < payloadLen) {
      break;
    }

    const payload = new Uint8Array(reader.readBytes(payloadLen));
    if (!currentTouchRect) {
      continue;
    }

    const payloadReader = new BinaryReader(payload);
    switch (propertyType) {
      case 3: {
        if (payloadReader.remaining < 16) break;
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const minX = dv.getInt32(0, true);
        const minY = dv.getInt32(4, true);
        const maxX = dv.getInt32(8, true);
        const maxY = dv.getInt32(12, true);
        currentTouchRect.scrollLimits = { minX, minY, maxX, maxY };
        break;
      }
      case 4: {
        if (payloadReader.remaining < 8) break;
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        currentTouchRect.zoomLimits = {
          min: dv.getFloat32(0, true),
          max: dv.getFloat32(4, true),
        };
        break;
      }
      case 6: {
        if (payloadReader.remaining < 10) break;
        const id = payloadReader.readUint16();
        const layerId = payloadReader.readUint16();
        const lockScrollX = payloadReader.readUint8() !== 0;
        const lockScrollY = payloadReader.readUint8() !== 0;
        const offsetX = payloadReader.readUint16();
        const offsetY = payloadReader.readUint16();
        currentTouchRect.subTargets.push({
          id,
          layerId,
          lockScrollX,
          lockScrollY,
          offsetX,
          offsetY,
        });
        break;
      }
      default:
        break;
    }
  }

  return touchRects;
}

export function extractTouchRectangles(commands: PaintCommand[]): TouchRectangleCommand[] {
  const touchRects: TouchRectangleCommand[] = [];
  for (const cmd of commands) {
    if (!isTouchRectanglesCommand(cmd)) continue;
    touchRects.push(...parseTouchRectanglesCommand(cmd));
  }
  return touchRects;
}

export function extractLatestTouchRectangles(commands: PaintCommand[]): TouchRectangleCommand[] {
  for (let i = commands.length - 1; i >= 0; i--) {
    const cmd = commands[i];
    if (!isTouchRectanglesCommand(cmd)) continue;
    const parsed = parseTouchRectanglesCommand(cmd);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

function inferStatusFromImageId(imageId: string): boolean | null {
  const id = imageId.toLowerCase().replace(/\x00+$/g, '');
  const normalized = id
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  // Known lamp symbols from application.imagepoolcollection.csv.
  if (normalized.includes('element-lamp-lamp1-yellow-on')) return true;
  if (normalized.includes('element-lamp-lamp1-yellow-off')) return false;

  const onPattern = /(^|[./_-])(on|ein|an|true|active|enabled)([./_-]|$)/;
  const offPattern = /(^|[./_-])(off|aus|false|inactive|disabled)([./_-]|$)/;
  if (onPattern.test(id)) return true;
  if (offPattern.test(id)) return false;
  return null;
}

/**
 * Extract fill colors from paint commands that affect a given status indicator region.
 *
 * Strategy: Look for SetFillColor commands followed by rect drawing commands
 * that overlap the status indicator coordinates. Also collect all colors
 * from Fill3DRect commands in the region.
 *
 * Returns colors in paint order (last color is the visible one).
 */
export function extractStatusColors(
  commands: PaintCommand[],
  region: StatusRegion
): Array<{ r: number; g: number; b: number }> {
  const colors: Array<{ r: number; g: number; b: number }> = [];
  let lastFillColor: { r: number; g: number; b: number } | null = null;

  for (const cmd of commands) {
    if (cmd.id === CMD_SET_FILL_COLOR && cmd.data.length >= 4) {
      const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
      // SetFillColor format: flags(4) + argb(4). ARGB is at offset 4 when 8+ bytes present;
      // fall back to offset 0 for legacy 4-byte payloads.
      const argb = cmd.data.length >= 8 ? dv.getUint32(4, true) : dv.getUint32(0, true);
      lastFillColor = {
        r: (argb >>> 16) & 0xFF,
        g: (argb >>> 8) & 0xFF,
        b: argb & 0xFF,
      };
    } else if (cmd.id === CMD_FILL_3D_RECT && cmd.data.length >= 8) {
      const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
      const rx = dv.getInt16(0, true);
      const ry = dv.getInt16(2, true);
      const rw = dv.getInt16(4, true);
      const rh = dv.getInt16(6, true);

      // Check if the rect overlaps with our status indicator region
      if (overlapsRegion(rx, ry, rw, rh, region)) {

        // Use the rect's own fill color if available
        if (cmd.data.length >= 12) {
          const argb = dv.getUint32(8, true);
          colors.push({
            r: (argb >>> 16) & 0xFF,
            g: (argb >>> 8) & 0xFF,
            b: argb & 0xFF,
          });
        } else if (lastFillColor) {
          colors.push(lastFillColor);
        }
      }
    } else if (cmd.id === CMD_CLEAR_RECT && cmd.data.length >= 8 && lastFillColor) {
      const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
      const rx = dv.getInt16(0, true);
      const ry = dv.getInt16(2, true);
      const rw = dv.getInt16(4, true);
      const rh = dv.getInt16(6, true);

      if (overlapsRegion(rx, ry, rw, rh, region)) {
        colors.push(lastFillColor);
      }
    }
  }

  return colors;
}

/**
 * Extract DrawImage commands that overlap a status indicator region.
 * The browser visualization often renders status lamps as images instead of raw fill colors.
 */
export function extractStatusImages(
  commands: PaintCommand[],
  region: StatusRegion
): ImageDrawCommand[] {
  return extractDrawImages(commands).filter((image) =>
    overlapsRegion(image.x, image.y, image.width, image.height, region)
  );
}

/**
 * Infer ON/OFF state from image-based status indicators.
 * Prefer tint color when command flags indicate tinted image rendering.
 */
export function determineStatusFromImages(images: ImageDrawCommand[]): boolean | null {
  if (images.length === 0) return null;

  // Prefer explicit ON/OFF image names (e.g. Element-Lamp-Lamp1-Yellow-On/Off).
  for (let i = images.length - 1; i >= 0; i--) {
    const fromId = inferStatusFromImageId(images[i].imageId);
    if (fromId !== null) return fromId;
  }

  // Note: flag 0x20 with tintColor is a chroma key (transparency color), not a visual tint.
  // Status can only be reliably inferred from image names, not from the chroma key color.

  return null;
}

/**
 * Determine ON/OFF status from paint command colors.
 * Uses same thresholds as the Playwright pixel-based detection:
 * yellow (R>140 && G>140) = ON, brown = OFF.
 *
 * Returns the last matching color's status, or null if no status colors found.
 */
export function determineStatus(colors: Array<{ r: number; g: number; b: number }>): boolean | null {
  if (colors.length === 0) return null;

  // Use the last color (most recent paint) as the visible one
  const last = colors[colors.length - 1];
  return last.r > 140 && last.g > 140;
}
