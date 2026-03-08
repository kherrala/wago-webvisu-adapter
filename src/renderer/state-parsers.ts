import {
  RgbaColor,
  FontState,
  PenState,
  SurfaceClipRect,
  argbToColor,
  withVisibleAlpha,
} from './types';
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

export function parseAreaStyleCommand(command: PaintCommand): {
  fillColor: RgbaColor;
  borderColor: RgbaColor;
  fillDisabled: boolean;
} | null {
  if (command.data.length < 12) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const fillDisabled = dv.getUint32(0, true) === 1;
  const borderColor = withVisibleAlpha(argbToColor(dv.getUint32(4, true)));
  const fillColor = withVisibleAlpha(argbToColor(dv.getUint32(8, true)));
  return { fillColor, borderColor, fillDisabled };
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
