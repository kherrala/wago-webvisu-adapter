import {
  RgbaColor,
  PrimitiveShapeKind,
  SurfaceClipRect,
  SurfacePoint,
  argbToColor,
  withVisibleAlpha,
} from './types';
import { parseRectFromTwoPoints, parseQuadRect } from './geometry';
import { PaintCommand } from '../protocol/paint-commands';
import {
  CMD_DRAW_POLYGON_FLOAT,
  CMD_DRAW_PRIMITIVE,
  CMD_DRAW_SHAPE,
  CMD_DRAW_PRIMITIVE_FLOAT_QUAD,
  CMD_DRAW_PRIMITIVE_FLOAT_RECT,
  CMD_DRAW_SHAPE_AT_PEN,
} from '../protocol/command-ids';

export function parsePrimitiveCommand(command: PaintCommand): {
  kind: PrimitiveShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  if (command.data.length < 2) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const kindRaw = dv.getUint16(0, true);
  if (kindRaw > 4) {
    return null;
  }
  let rect: SurfaceClipRect | null = null;
  if (command.id === CMD_DRAW_PRIMITIVE) {
    rect = parseRectFromTwoPoints(command, 2, false);
  } else if (command.id === CMD_DRAW_SHAPE) {
    rect = parseQuadRect(command, 2, false);
  } else if (command.id === CMD_DRAW_PRIMITIVE_FLOAT_QUAD) {
    rect = parseQuadRect(command, 2, true);
  } else if (command.id === CMD_DRAW_PRIMITIVE_FLOAT_RECT) {
    rect = parseRectFromTwoPoints(command, 2, true);
  }
  if (!rect) {
    return null;
  }
  return {
    kind: kindRaw as PrimitiveShapeKind,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

export function parseFill3dRectCommand(command: PaintCommand): {
  x: number;
  y: number;
  width: number;
  height: number;
  style: number;
  color: RgbaColor;
} | null {
  // Fill3DRect format (from reference webvisu.js Fill3DRect constructor):
  //   4 quad points: 8 x int16 = 16 bytes  (GeometryUtil.ad reads 4 points)
  //   raised flag:   int8                   (1 byte)
  //   style:         int8                   (1 byte)
  //   style 2/4:     fillArgb(4) + highlightArgb(4) + shadowArgb(4)
  //   style 1/3:     borderWidth(int16) + fillArgb(4)
  // Minimum size: 16 + 2 = 18 bytes.
  if (command.data.length < 18) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);

  // Read quad: point[0]=(left,top), point[2]=(right,bottom)
  const left = dv.getInt16(0, true);    // point[0].x
  const top = dv.getInt16(2, true);     // point[0].y
  // point[1] at offsets 4-7 (skip)
  const right = dv.getInt16(8, true);   // point[2].x
  const bottom = dv.getInt16(10, true); // point[2].y
  // point[3] at offsets 12-15 (skip)

  const x = Math.min(left, right);
  const y = Math.min(top, bottom);
  const width = Math.abs(right - left);
  const height = Math.abs(bottom - top);

  // byte 16: raised flag (unused for debug rendering)
  const style = dv.getInt8(17);

  // Style 0 or unknown: no-op in reference (switch has no default case)
  if (style < 1 || style > 4) {
    return null;
  }

  // Read fill color based on style
  let fillArgb: number;
  if (style === 2 || style === 4) {
    if (command.data.length < 22) return null;
    fillArgb = dv.getUint32(18, true);
  } else {
    // style 1 or 3: int16 borderWidth at offset 18, then uint32 fillColor at offset 20
    if (command.data.length < 24) return null;
    fillArgb = dv.getUint32(20, true);
  }

  return {
    x, y, width, height,
    style,
    color: withVisibleAlpha(argbToColor(fillArgb)),
  };
}

export function parsePolygonCommand(command: PaintCommand): { mode: number; points: SurfacePoint[] } | null {
  if (command.data.length < 8) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const mode = dv.getUint16(0, true);
  const pointCount = dv.getUint16(2, true);
  if (pointCount < 2 || pointCount > 128) {
    return null;
  }
  const floatCoords = command.id === CMD_DRAW_POLYGON_FLOAT;
  const pointStride = floatCoords ? 8 : 4;
  const required = 4 + (pointCount * pointStride);
  if (command.data.length < required) {
    return null;
  }
  const points: SurfacePoint[] = [];
  for (let i = 0; i < pointCount; i++) {
    const offset = 4 + (i * pointStride);
    const x = floatCoords ? Math.round(dv.getFloat32(offset, true)) : dv.getInt16(offset, true);
    const y = floatCoords
      ? Math.round(dv.getFloat32(offset + 4, true))
      : dv.getInt16(offset + 2, true);
    points.push({ x, y });
  }
  return { mode, points };
}

/**
 * Parse DrawShapeAtPen (ID 31): draws a shape at the current pen position.
 * Data layout (14 bytes, may have padding to 16):
 *   offset 0: shapeType (uint16) — 0=rect, 1=rounded rect, 2=ellipse, 3=backslash, 4=forward slash
 *   offset 2: cellWidth (uint16)
 *   offset 4: cellHeight (uint16)
 *   offset 6: advanceDx (uint16)
 *   offset 8: advanceDy (uint16)
 *   offset 10: flags (uint32) — bit 0=advance pen X, bit 1=advance pen Y, bit 2=use reference rect
 */
export function parseDrawShapeAtPenCommand(command: PaintCommand): {
  kind: PrimitiveShapeKind;
  cellWidth: number;
  cellHeight: number;
  advanceDx: number;
  advanceDy: number;
  advancePenX: boolean;
  advancePenY: boolean;
} | null {
  if (command.id !== CMD_DRAW_SHAPE_AT_PEN || command.data.length < 14) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const kindRaw = dv.getUint16(0, true);
  if (kindRaw > 4) return null;
  const cellWidth = dv.getUint16(2, true);
  const cellHeight = dv.getUint16(4, true);
  const advanceDx = dv.getUint16(6, true);
  const advanceDy = dv.getUint16(8, true);
  const flags = dv.getUint32(10, true);
  return {
    kind: kindRaw as PrimitiveShapeKind,
    cellWidth,
    cellHeight,
    advanceDx,
    advanceDy,
    advancePenX: (flags & 1) !== 0,
    advancePenY: (flags & 2) !== 0,
  };
}

export function parsePointsCommand(command: PaintCommand): SurfacePoint[] | null {
  if (command.data.length < 2) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const pointCount = dv.getUint16(0, true);
  if (pointCount <= 0 || pointCount > 4096) {
    return null;
  }
  const required = 2 + (pointCount * 4);
  if (command.data.length < required) {
    return null;
  }
  const points: SurfacePoint[] = [];
  for (let i = 0; i < pointCount; i++) {
    const offset = 2 + (i * 4);
    points.push({
      x: dv.getInt16(offset, true),
      y: dv.getInt16(offset + 2, true),
    });
  }
  return points;
}
