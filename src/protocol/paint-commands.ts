// Paint command stream parser focused on status color extraction

import { BinaryReader } from './binary';

// Paint command IDs relevant to status detection
export const CMD_SET_FILL_COLOR = 4;
export const CMD_FILL_3D_RECT = 23;
export const CMD_CLEAR_RECT = 7;
export const CMD_DRAW_IMAGE = 19;

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
  if (cmd.id !== 46 || cmd.data.length < 14) return null;
  const dv = new DataView(cmd.data.buffer, cmd.data.byteOffset, cmd.data.byteLength);
  const left = dv.getInt16(0, true);
  const top = dv.getInt16(2, true);
  const right = dv.getInt16(4, true);
  const bottom = dv.getInt16(6, true);
  const flags = dv.getUint32(8, true);
  const textLen = dv.getUint16(12, true);
  if (cmd.data.length < 14 + textLen) return null;
  const textBytes = cmd.data.subarray(14, 14 + textLen);
  const text = decodeLatin1(textBytes).replace(/\x00+$/g, '');
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
