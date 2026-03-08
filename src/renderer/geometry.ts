import { SurfaceClipRect } from './types';
import { PaintCommand } from '../protocol/paint-commands';

export function normalizeClipRect(x: number, y: number, width: number, height: number): SurfaceClipRect {
  let left = x;
  let top = y;
  let rectWidth = width;
  let rectHeight = height;

  if (rectWidth < 0) {
    left += rectWidth;
    rectWidth = -rectWidth;
  }
  if (rectHeight < 0) {
    top += rectHeight;
    rectHeight = -rectHeight;
  }
  if (rectWidth <= 0 || rectHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x: left, y: top, width: rectWidth, height: rectHeight };
}

export function normalizeClipRectFromPoints(x1: number, y1: number, x2: number, y2: number): SurfaceClipRect {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return normalizeClipRect(left, top, width, height);
}

export function intersectClipRects(a: SurfaceClipRect, b: SurfaceClipRect): SurfaceClipRect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) {
    return null;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function parseRectFromTwoPoints(
  command: PaintCommand,
  offset: number = 0,
  floatCoords: boolean = false,
): SurfaceClipRect | null {
  const needed = offset + (floatCoords ? 16 : 8);
  if (command.data.length < needed) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  const x1 = floatCoords ? Math.round(dv.getFloat32(offset, true)) : dv.getInt16(offset, true);
  const y1 = floatCoords ? Math.round(dv.getFloat32(offset + 4, true)) : dv.getInt16(offset + 2, true);
  const x2 = floatCoords ? Math.round(dv.getFloat32(offset + 8, true)) : dv.getInt16(offset + 4, true);
  const y2 = floatCoords ? Math.round(dv.getFloat32(offset + 12, true)) : dv.getInt16(offset + 6, true);
  return normalizeClipRectFromPoints(x1, y1, x2, y2);
}

export function parseQuadRect(
  command: PaintCommand,
  offset: number,
  floatCoords: boolean,
): SurfaceClipRect | null {
  const pointStride = floatCoords ? 8 : 4;
  const needed = offset + (pointStride * 4);
  if (command.data.length < needed) {
    return null;
  }
  const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < 4; i++) {
    const pointOffset = offset + (i * pointStride);
    const x = floatCoords ? dv.getFloat32(pointOffset, true) : dv.getInt16(pointOffset, true);
    const y = floatCoords ? dv.getFloat32(pointOffset + 4, true) : dv.getInt16(pointOffset + 2, true);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return normalizeClipRectFromPoints(
    Math.round(minX),
    Math.round(minY),
    Math.round(maxX),
    Math.round(maxY),
  );
}
