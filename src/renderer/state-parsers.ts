import {
  RgbaColor,
  FontState,
  GradientState,
  PenState,
  SurfaceClipRect,
  argbToColor,
  withVisibleAlpha,
} from './types';
import { CMD_SET_AREA_STYLE_LEGACY } from '../protocol/command-ids';
import { parseRectFromTwoPoints } from './geometry';
import { PaintCommand } from '../protocol/paint-commands';

export function parseFillColorCommand(command: PaintCommand): { color: RgbaColor; disabled: boolean } | null {
  if (command.data.length < 8) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const flags = dv.getUint32(0, true);
  return {
    color: withVisibleAlpha(argbToColor(dv.getUint32(4, true))),
    disabled: (flags & 0x1) !== 0,
  };
}

export function parsePenStyleCommand(command: PaintCommand): PenState | null {
  if (command.data.length < 10) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const lineStyle = dv.getUint32(0, true);
  const widthRaw = Math.max(0, dv.getUint16(8, true));
  const color = withVisibleAlpha(argbToColor(dv.getUint32(4, true)));
  let lineCap: PenState['lineCap'] = 'butt';
  let lineJoin: PenState['lineJoin'] = 'miter';
  let miterLimit = 1.7 * Math.max(1, widthRaw || 1);

  if (command.data.length >= 16) {
    const capBits = dv.getUint16(10, true);
    const joinBits = dv.getUint16(12, true);
    const miterRaw = dv.getUint16(14, true);

    if ((capBits & 0x2) !== 0) {
      lineCap = 'round';
    } else if ((capBits & 0x1) !== 0) {
      lineCap = 'square';
    }

    if ((joinBits & 0x2) !== 0) {
      lineJoin = 'round';
    } else if ((joinBits & 0x1) !== 0) {
      lineJoin = 'bevel';
    }

    miterLimit = miterRaw === 1
      ? 1.7 * Math.max(1, widthRaw || 1)
      : Math.max(1, 2 * miterRaw);
  }

  const dashPatternMap: Record<number, number[] | null> = {
    0: null,
    1: [8, 3],
    2: [3, 3],
    3: [8, 3, 3, 3],
    4: [8, 3, 3, 3, 3, 3],
  };

  return {
    color,
    width: Math.max(1, Math.min(8, widthRaw || 1)),
    strokeEnabled: lineStyle !== 5,
    lineStyle,
    lineCap,
    lineJoin,
    miterLimit,
    dashPattern: dashPatternMap[lineStyle] ?? null,
  };
}

export function parseFontCommand(command: PaintCommand, fallback: FontState): FontState | null {
  if (command.data.length < 12) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const color = withVisibleAlpha(argbToColor(dv.getUint32(0, true)));
  const styleFlags = dv.getUint32(4, true);
  const sizeRaw = dv.getUint16(8, true);
  const familyLength = dv.getUint16(10, true);
  if (command.data.length < 12 + familyLength) {
    return null;
  }
  const family = Buffer
    .from(command.data.subarray(12, 12 + familyLength))
    .toString('latin1')
    .replace(/\x00+$/g, '')
    .trim() || fallback.family;
  const size = Math.max(6, Math.min(96, sizeRaw || fallback.size));
  return {
    family,
    size,
    color,
    bold: (styleFlags & 0x2) !== 0,
    italic: (styleFlags & 0x1) !== 0,
    underline: (styleFlags & 0x4) !== 0,
    strikeout: (styleFlags & 0x8) !== 0,
  };
}

/**
 * Parses CMD_SET_AREA_STYLE (48) and CMD_SET_AREA_STYLE_LEGACY (30).
 *
 * Binary layout (webvisu-deobfuscated.js AreaGradientStyle, lines 6797–6812):
 *
 * Common header (both formats):
 *   offset  0 (uint32): gradientEnabled — 1 = gradient active, 0 = solid fill
 *   offset  4 (uint32): color1 ARGB — gradient start color (or border color in solid mode)
 *   offset  8 (uint32): color2 ARGB — gradient end color (or fill color in solid mode)
 *
 * Legacy (id=30), offsets 12+:
 *   offset 12 (uint32): angle in degrees
 *   offset 16 (uint32): horizontal center percentage (0–100, divide by 100 → 0–1)
 *   offset 20 (uint32): vertical center percentage (0–100, divide by 100 → 0–1)
 *   offset 24 (uint32): gradient type (0=linear, 1=radial, 2=reflected)
 *   offset 28 (uint32): swapColors — 0 = swap, non-zero = don't swap
 *   offset 32 (uint32): (padding, skip)
 *   offset 36 (uint32): color3 ARGB
 *
 * Modern (id=48), offsets 12+:
 *   offset 12 (uint16): angle in degrees
 *   offset 14 (uint8):  horizontal center percentage (divide by 100)
 *   offset 15 (uint8):  vertical center percentage (divide by 100)
 *   offset 16 (uint8):  gradient type (0=linear, 1=radial, 2=reflected)
 *   swapColors = always true, color3 = 0
 */
export function parseAreaStyleCommand(command: PaintCommand): {
  fillColor: RgbaColor;
  borderColor: RgbaColor;
  fillDisabled: boolean;
  gradient: GradientState | null;
} | null {
  const isLegacy = command.id === CMD_SET_AREA_STYLE_LEGACY;
  const minLen = isLegacy ? 40 : 17;
  if (command.data.length < minLen) {
    return null;
  }

  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const gradientEnabled = dv.getUint32(0, true) === 1;
  const color1 = withVisibleAlpha(argbToColor(dv.getUint32(4, true)));
  const color2 = withVisibleAlpha(argbToColor(dv.getUint32(8, true)));

  // In solid mode, color1 = border/pen color, color2 = fill color (empirical convention).
  const borderColor = color1;
  const fillColor = color2;

  if (!gradientEnabled) {
    return { fillColor, borderColor, fillDisabled: false, gradient: null };
  }

  // Parse gradient parameters
  let angleDeg: number;
  let hCenter: number;
  let vCenter: number;
  let gradientType: number;
  let swapColors: boolean;
  let color3 = withVisibleAlpha(argbToColor(0));

  if (isLegacy) {
    angleDeg = dv.getUint32(12, true);
    hCenter = dv.getUint32(16, true) / 100;
    vCenter = dv.getUint32(20, true) / 100;
    gradientType = dv.getUint32(24, true);
    swapColors = dv.getUint32(28, true) === 0;
    color3 = withVisibleAlpha(argbToColor(dv.getUint32(36, true)));
  } else {
    angleDeg = dv.getUint16(12, true);
    hCenter = dv.getUint8(14) / 100;
    vCenter = dv.getUint8(15) / 100;
    gradientType = dv.getUint8(16);
    swapColors = true;
  }

  const type = (gradientType === 0 || gradientType === 1 || gradientType === 2)
    ? gradientType as 0 | 1 | 2
    : 0;

  // Replicate GradientFill constructor color/angle swap logic
  // (webvisu-deobfuscated.js lines 623–624):
  //   (type 0 or 2) && angle > 180 → angle -= 180, bi = swapColors ? color2 : color3, tg = color1
  //   else                         → bi = color1, tg = swapColors ? color2 : color3
  let finalAngle = angleDeg % 360;
  let gradColor1: RgbaColor;
  let gradColor2: RgbaColor;

  if ((type === 0 || type === 2) && finalAngle > 180) {
    finalAngle -= 180;
    gradColor1 = swapColors ? color2 : color3;
    gradColor2 = color1;
  } else {
    gradColor1 = color1;
    gradColor2 = swapColors ? color2 : color3;
  }

  const gradient: GradientState = {
    type,
    angle: finalAngle,
    centerX: hCenter,
    centerY: vCenter,
    color1: gradColor1,
    color2: gradColor2,
  };

  return { fillColor, borderColor, fillDisabled: false, gradient };
}

export function parseVisualizationNamespace(command: PaintCommand): string | null {
  if (command.data.length < 3) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const length = dv.getUint16(0, true);
  if (command.data.length < 2 + length) {
    return null;
  }
  const namespace = Buffer
    .from(command.data.subarray(2, 2 + length))
    .toString('latin1')
    .replace(/\x00+$/g, '')
    .trim();
  return namespace || null;
}

export function parseRenderParameterCommand(command: PaintCommand): { id: number; value: number } | null {
  if (command.data.length < 8) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  return {
    id: dv.getUint16(0, true),
    value: dv.getInt32(4, true),
  };
}

export function parseClipRectCommand(command: PaintCommand): SurfaceClipRect | null {
  const rect = parseRectFromTwoPoints(command, 0, false);
  if (!rect) return null;
  // Reference SetClipRect adds +1 to width/height: a.rect(left, top, getWidth()+1, getHeight()+1)
  return { x: rect.x, y: rect.y, width: rect.width + 1, height: rect.height + 1 };
}

export function parseCornerRadiusCommand(command: PaintCommand): { x: number; y: number } | null {
  if (command.data.length < 4) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  return {
    x: dv.getInt16(0, true),
    y: dv.getInt16(2, true),
  };
}

export function parseLayerSwitchCommand(command: PaintCommand): number | null {
  if (command.data.length < 2) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  return dv.getInt16(0, true);
}

export function parseCursorStyleCommand(command: PaintCommand): string | null {
  if (command.data.length < 2) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const styleId = dv.getUint16(0, true);
  const map: Record<number, string> = {
    0: 'pointer',
    1: 'default',
    2: 'pointer',
    3: 'wait',
    4: 'text',
    5: 'crosshair',
    6: 'help',
    7: 'col-resize',
    8: 'row-resize',
    9: 'nw-resize',
    10: 'ne-resize',
    11: 'w-resize',
    12: 's-resize',
    13: 'pointer',
  };
  return map[styleId] ?? 'default';
}
