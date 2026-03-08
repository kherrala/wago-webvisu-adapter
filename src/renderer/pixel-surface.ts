import { RgbaColor, SurfaceClipRect, SurfacePoint } from './types';

export class PixelSurface {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  private readonly background: RgbaColor;

  constructor(width: number, height: number, background: RgbaColor) {
    this.width = width;
    this.height = height;
    this.background = { ...background };
    this.pixels = new Uint8Array(width * height * 4);
    this.clearRect(0, 0, width, height, this.background);
  }

  clone(): PixelSurface {
    const cloned = new PixelSurface(this.width, this.height, this.background);
    cloned.pixels.set(this.pixels);
    return cloned;
  }

  /**
   * Returns the bounding box of pixels that differ from the background color,
   * or null if the entire surface matches the background.
   */
  contentBounds(): { x: number; y: number; width: number; height: number } | null {
    const { r: br, g: bg, b: bb } = this.background;
    let minX = this.width;
    let minY = this.height;
    let maxX = -1;
    let maxY = -1;
    for (let py = 0; py < this.height; py++) {
      let offset = py * this.width * 4;
      for (let px = 0; px < this.width; px++) {
        if (
          this.pixels[offset] !== br
          || this.pixels[offset + 1] !== bg
          || this.pixels[offset + 2] !== bb
        ) {
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
        offset += 4;
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /**
   * Returns a new PixelSurface containing the specified sub-region.
   */
  crop(x: number, y: number, width: number, height: number): PixelSurface {
    const cropped = new PixelSurface(width, height, this.background);
    for (let py = 0; py < height; py++) {
      const srcRow = ((y + py) * this.width + x) * 4;
      const dstRow = py * width * 4;
      cropped.pixels.set(this.pixels.subarray(srcRow, srcRow + width * 4), dstRow);
    }
    return cropped;
  }

  fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: RgbaColor,
    clip?: SurfaceClipRect,
  ): void {
    const bounds = this.getDrawBounds(x, y, width, height, clip);
    if (!bounds) {
      return;
    }
    const sourceAlpha = Math.max(0, Math.min(255, color.a));
    const alpha = sourceAlpha / 255;
    const inverse = 1 - alpha;
    for (let py = bounds.y0; py < bounds.y1; py++) {
      let offset = ((py * this.width) + bounds.x0) * 4;
      for (let px = bounds.x0; px < bounds.x1; px++) {
        const dr = this.pixels[offset];
        const dg = this.pixels[offset + 1];
        const db = this.pixels[offset + 2];
        this.pixels[offset] = Math.round((color.r * alpha) + (dr * inverse));
        this.pixels[offset + 1] = Math.round((color.g * alpha) + (dg * inverse));
        this.pixels[offset + 2] = Math.round((color.b * alpha) + (db * inverse));
        this.pixels[offset + 3] = 255;
        offset += 4;
      }
    }
  }

  clearRect(
    x: number,
    y: number,
    width: number,
    height: number,
    clearColor: RgbaColor,
    clip?: SurfaceClipRect,
  ): void {
    const bounds = this.getDrawBounds(x, y, width, height, clip);
    if (!bounds) {
      return;
    }
    const a = Math.max(0, Math.min(255, clearColor.a));
    for (let py = bounds.y0; py < bounds.y1; py++) {
      let offset = ((py * this.width) + bounds.x0) * 4;
      for (let px = bounds.x0; px < bounds.x1; px++) {
        this.pixels[offset] = clearColor.r;
        this.pixels[offset + 1] = clearColor.g;
        this.pixels[offset + 2] = clearColor.b;
        this.pixels[offset + 3] = a;
        offset += 4;
      }
    }
  }

  strokeRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: RgbaColor,
    thickness: number,
    clip?: SurfaceClipRect,
    dashPattern?: number[] | null,
    lineCap: 'butt' | 'square' | 'round' = 'butt',
    lineJoin: 'miter' | 'bevel' | 'round' = 'miter',
  ): void {
    this.drawLine(x, y, x + width - 1, y, color, thickness, clip, dashPattern, lineCap);
    this.drawLine(x + width - 1, y, x + width - 1, y + height - 1, color, thickness, clip, dashPattern, lineCap);
    this.drawLine(x + width - 1, y + height - 1, x, y + height - 1, color, thickness, clip, dashPattern, lineCap);
    this.drawLine(x, y + height - 1, x, y, color, thickness, clip, dashPattern, lineCap);
    if (lineJoin === 'round') {
      const radius = Math.max(1, Math.floor(thickness / 2));
      this.fillEllipse(x - radius, y - radius, radius * 2 + 1, radius * 2 + 1, color, clip);
      this.fillEllipse(x + width - 1 - radius, y - radius, radius * 2 + 1, radius * 2 + 1, color, clip);
      this.fillEllipse(x + width - 1 - radius, y + height - 1 - radius, radius * 2 + 1, radius * 2 + 1, color, clip);
      this.fillEllipse(x - radius, y + height - 1 - radius, radius * 2 + 1, radius * 2 + 1, color, clip);
    }
  }

  fillRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radiusX: number,
    radiusY: number,
    color: RgbaColor,
    clip?: SurfaceClipRect,
  ): void {
    if (radiusX <= 0 || radiusY <= 0) {
      this.fillRect(x, y, width, height, color, clip);
      return;
    }
    this.fillRect(x, y, width, height, color, clip);
  }

  strokeRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radiusX: number,
    radiusY: number,
    color: RgbaColor,
    thickness: number,
    clip?: SurfaceClipRect,
    dashPattern?: number[] | null,
    lineCap: 'butt' | 'square' | 'round' = 'butt',
    lineJoin: 'miter' | 'bevel' | 'round' = 'miter',
  ): void {
    if (radiusX <= 0 || radiusY <= 0) {
      this.strokeRect(x, y, width, height, color, thickness, clip, dashPattern, lineCap, lineJoin);
      return;
    }
    this.strokeRect(x, y, width, height, color, thickness, clip, dashPattern, lineCap, lineJoin);
  }

  drawLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: RgbaColor,
    thickness: number = 1,
    clip?: SurfaceClipRect,
    dashPattern?: number[] | null,
    lineCap: 'butt' | 'square' | 'round' = 'butt',
  ): void {
    let cx0 = Math.round(x0);
    let cy0 = Math.round(y0);
    let cx1 = Math.round(x1);
    let cy1 = Math.round(y1);
    const size = Math.max(1, Math.floor(thickness));
    const half = Math.floor(size / 2);

    // Square line caps extend both endpoints by half line width.
    if (lineCap === 'square') {
      const dx = cx1 - cx0;
      const dy = cy1 - cy0;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const ext = half;
        const ux = dx / len;
        const uy = dy / len;
        cx0 = Math.round(cx0 - (ux * ext));
        cy0 = Math.round(cy0 - (uy * ext));
        cx1 = Math.round(cx1 + (ux * ext));
        cy1 = Math.round(cy1 + (uy * ext));
      }
    }

    const dx = Math.abs(cx1 - cx0);
    const sx = cx0 < cx1 ? 1 : -1;
    const dy = -Math.abs(cy1 - cy0);
    const sy = cy0 < cy1 ? 1 : -1;
    let err = dx + dy;
    const points: SurfacePoint[] = [];

    while (true) {
      points.push({ x: cx0, y: cy0 });
      if (cx0 === cx1 && cy0 === cy1) {
        break;
      }
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        cx0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        cy0 += sy;
      }
    }

    let draw = true;
    let dashIndex = 0;
    let dashRemaining = dashPattern && dashPattern.length > 0
      ? Math.max(1, Math.round(dashPattern[0]))
      : Number.POSITIVE_INFINITY;

    for (const point of points) {
      if (draw) {
        this.fillRect(point.x - half, point.y - half, size, size, color, clip);
      }
      dashRemaining--;
      if (dashRemaining <= 0 && dashPattern && dashPattern.length > 0) {
        dashIndex = (dashIndex + 1) % dashPattern.length;
        dashRemaining = Math.max(1, Math.round(dashPattern[dashIndex]));
        draw = !draw;
      }
    }

    if (lineCap === 'round') {
      const radius = Math.max(1, Math.floor(size / 2));
      this.fillEllipse(Math.round(x0) - radius, Math.round(y0) - radius, radius * 2 + 1, radius * 2 + 1, color, clip);
      this.fillEllipse(Math.round(x1) - radius, Math.round(y1) - radius, radius * 2 + 1, radius * 2 + 1, color, clip);
    }
  }

  strokePolyline(
    points: SurfacePoint[],
    color: RgbaColor,
    thickness: number = 1,
    clip?: SurfaceClipRect,
    dashPattern?: number[] | null,
    lineCap: 'butt' | 'square' | 'round' = 'butt',
    lineJoin: 'miter' | 'bevel' | 'round' = 'miter',
  ): void {
    if (points.length < 2) {
      return;
    }
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      this.drawLine(a.x, a.y, b.x, b.y, color, thickness, clip, dashPattern, lineCap);
      if (lineJoin === 'round') {
        const radius = Math.max(1, Math.floor(thickness / 2));
        this.fillEllipse(b.x - radius, b.y - radius, radius * 2 + 1, radius * 2 + 1, color, clip);
      }
    }
  }

  strokePolygon(
    points: SurfacePoint[],
    color: RgbaColor,
    thickness: number = 1,
    clip?: SurfaceClipRect,
    dashPattern?: number[] | null,
    lineCap: 'butt' | 'square' | 'round' = 'butt',
    lineJoin: 'miter' | 'bevel' | 'round' = 'miter',
  ): void {
    if (points.length < 2) {
      return;
    }
    this.strokePolyline(points, color, thickness, clip, dashPattern, lineCap, lineJoin);
    this.drawLine(
      points[points.length - 1].x,
      points[points.length - 1].y,
      points[0].x,
      points[0].y,
      color,
      thickness,
      clip,
      dashPattern,
      lineCap,
    );
    if (lineJoin === 'round') {
      const radius = Math.max(1, Math.floor(thickness / 2));
      this.fillEllipse(points[0].x - radius, points[0].y - radius, radius * 2 + 1, radius * 2 + 1, color, clip);
    }
  }

  strokeBezierPolyline(
    points: SurfacePoint[],
    color: RgbaColor,
    thickness: number = 1,
    clip?: SurfaceClipRect,
    dashPattern?: number[] | null,
    lineCap: 'butt' | 'square' | 'round' = 'butt',
  ): void {
    if (points.length < 2) {
      return;
    }

    let current = points[0];
    let i = 1;

    for (; i + 2 < points.length; i += 3) {
      const c1 = points[i];
      const c2 = points[i + 1];
      const end = points[i + 2];
      const estimate = Math.hypot(c1.x - current.x, c1.y - current.y)
        + Math.hypot(c2.x - c1.x, c2.y - c1.y)
        + Math.hypot(end.x - c2.x, end.y - c2.y);
      const steps = Math.max(8, Math.ceil(estimate / 4));
      let prev = current;
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const next = this.sampleCubicBezierPoint(current, c1, c2, end, t);
        this.drawLine(prev.x, prev.y, next.x, next.y, color, thickness, clip, dashPattern, lineCap);
        prev = next;
      }
      current = end;
    }

    for (; i < points.length; i++) {
      const next = points[i];
      this.drawLine(current.x, current.y, next.x, next.y, color, thickness, clip, dashPattern, lineCap);
      current = next;
    }
  }

  fillPolygon(points: SurfacePoint[], color: RgbaColor, clip?: SurfaceClipRect): void {
    if (points.length < 3) {
      return;
    }

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of points) {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(this.height - 1, Math.ceil(maxY));
    for (let y = yStart; y <= yEnd; y++) {
      const intersections: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const ay = a.y;
        const by = b.y;
        const crosses = (ay <= y && by > y) || (by <= y && ay > y);
        if (!crosses) continue;
        const t = (y - ay) / (by - ay);
        intersections.push(a.x + (t * (b.x - a.x)));
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const x0 = Math.floor(intersections[i]);
        const x1 = Math.ceil(intersections[i + 1]);
        this.fillRect(x0, y, Math.max(1, x1 - x0 + 1), 1, color, clip);
      }
    }
  }

  fillEllipse(
    x: number,
    y: number,
    width: number,
    height: number,
    color: RgbaColor,
    clip?: SurfaceClipRect,
  ): void {
    const bounds = this.getDrawBounds(x, y, width, height, clip);
    if (!bounds) {
      return;
    }
    const rx = Math.max(0.5, bounds.width / 2);
    const ry = Math.max(0.5, bounds.height / 2);
    const cx = bounds.left + (bounds.width / 2);
    const cy = bounds.top + (bounds.height / 2);
    for (let py = bounds.y0; py < bounds.y1; py++) {
      const ny = ((py + 0.5) - cy) / ry;
      for (let px = bounds.x0; px < bounds.x1; px++) {
        const nx = ((px + 0.5) - cx) / rx;
        if ((nx * nx) + (ny * ny) <= 1) {
          this.fillRect(px, py, 1, 1, color);
        }
      }
    }
  }

  strokeEllipse(
    x: number,
    y: number,
    width: number,
    height: number,
    color: RgbaColor,
    thickness: number,
    clip?: SurfaceClipRect,
    dashPattern?: number[] | null,
    lineCap: 'butt' | 'square' | 'round' = 'butt',
  ): void {
    const bounds = this.getDrawBounds(x, y, width, height, clip);
    if (!bounds) {
      return;
    }
    const rx = Math.max(0.5, bounds.width / 2);
    const ry = Math.max(0.5, bounds.height / 2);
    const innerRx = Math.max(0, rx - Math.max(1, thickness));
    const innerRy = Math.max(0, ry - Math.max(1, thickness));
    const cx = bounds.left + (bounds.width / 2);
    const cy = bounds.top + (bounds.height / 2);

    for (let py = bounds.y0; py < bounds.y1; py++) {
      const ny = ((py + 0.5) - cy) / ry;
      const innerNy = innerRy > 0 ? ((py + 0.5) - cy) / innerRy : 0;
      for (let px = bounds.x0; px < bounds.x1; px++) {
        const nx = ((px + 0.5) - cx) / rx;
        const outer = (nx * nx) + (ny * ny);
        if (outer > 1) {
          continue;
        }
        if (innerRx <= 0 || innerRy <= 0) {
          this.fillRect(px, py, 1, 1, color);
          continue;
        }
        const innerNx = ((px + 0.5) - cx) / innerRx;
        const inner = (innerNx * innerNx) + (innerNy * innerNy);
        if (inner >= 1) {
          this.fillRect(px, py, 1, 1, color);
        }
      }
    }
    if (lineCap === 'round' && dashPattern && dashPattern.length > 0) {
      const radius = Math.max(1, Math.floor(thickness / 2));
      this.fillEllipse(Math.round(cx + rx) - radius, Math.round(cy) - radius, radius * 2 + 1, radius * 2 + 1, color, clip);
      this.fillEllipse(Math.round(cx - rx) - radius, Math.round(cy) - radius, radius * 2 + 1, radius * 2 + 1, color, clip);
    }
  }

  blitRgbaImage(
    src: Uint8Array,
    srcWidth: number,
    srcHeight: number,
    dstX: number,
    dstY: number,
    dstWidth: number,
    dstHeight: number,
    chromaKey: { r: number; g: number; b: number } | null = null,
    clip?: SurfaceClipRect,
  ): void {
    if (srcWidth <= 0 || srcHeight <= 0 || dstWidth === 0 || dstHeight === 0) {
      return;
    }
    const bounds = this.getDrawBounds(dstX, dstY, dstWidth, dstHeight, clip);
    if (!bounds) {
      return;
    }

    const sxScale = srcWidth / bounds.width;
    const syScale = srcHeight / bounds.height;

    for (let py = bounds.y0; py < bounds.y1; py++) {
      const srcY = Math.max(0, Math.min(srcHeight - 1, Math.floor((py - bounds.top) * syScale)));
      for (let px = bounds.x0; px < bounds.x1; px++) {
        const srcX = Math.max(0, Math.min(srcWidth - 1, Math.floor((px - bounds.left) * sxScale)));
        const srcOffset = ((srcY * srcWidth) + srcX) * 4;

        const sr = src[srcOffset];
        const sg = src[srcOffset + 1];
        const sb = src[srcOffset + 2];
        const saByte = src[srcOffset + 3];
        if (saByte === 0) {
          continue;
        }

        // Chroma key: make pixels matching the key color transparent (within tolerance of 2 per channel, matching webvisu.js fuzzy mode)
        if (chromaKey
          && Math.abs(sr - chromaKey.r) <= 2
          && Math.abs(sg - chromaKey.g) <= 2
          && Math.abs(sb - chromaKey.b) <= 2) {
          continue;
        }

        const sa = saByte / 255;
        const da = 1 - sa;
        const dstOffset = ((py * this.width) + px) * 4;
        const dr = this.pixels[dstOffset];
        const dg = this.pixels[dstOffset + 1];
        const db = this.pixels[dstOffset + 2];

        this.pixels[dstOffset] = Math.round((sr * sa) + (dr * da));
        this.pixels[dstOffset + 1] = Math.round((sg * sa) + (dg * da));
        this.pixels[dstOffset + 2] = Math.round((sb * sa) + (db * da));
        this.pixels[dstOffset + 3] = 255;
      }
    }
  }

  private getDrawBounds(
    x: number,
    y: number,
    width: number,
    height: number,
    clip?: SurfaceClipRect,
  ): { left: number; top: number; width: number; height: number; x0: number; y0: number; x1: number; y1: number } | null {
    let left = x;
    let top = y;
    let drawWidth = width;
    let drawHeight = height;
    if (drawWidth < 0) {
      left += drawWidth;
      drawWidth = -drawWidth;
    }
    if (drawHeight < 0) {
      top += drawHeight;
      drawHeight = -drawHeight;
    }
    if (drawWidth <= 0 || drawHeight <= 0) {
      return null;
    }

    let x0 = Math.max(0, Math.floor(left));
    let y0 = Math.max(0, Math.floor(top));
    let x1 = Math.min(this.width, Math.ceil(left + drawWidth));
    let y1 = Math.min(this.height, Math.ceil(top + drawHeight));
    if (clip) {
      x0 = Math.max(x0, Math.floor(clip.x));
      y0 = Math.max(y0, Math.floor(clip.y));
      x1 = Math.min(x1, Math.ceil(clip.x + clip.width));
      y1 = Math.min(y1, Math.ceil(clip.y + clip.height));
    }
    if (x0 >= x1 || y0 >= y1) {
      return null;
    }
    return { left, top, width: drawWidth, height: drawHeight, x0, y0, x1, y1 };
  }

  private sampleCubicBezierPoint(
    p0: SurfacePoint,
    p1: SurfacePoint,
    p2: SurfacePoint,
    p3: SurfacePoint,
    t: number,
  ): SurfacePoint {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const a = mt2 * mt;
    const b = 3 * mt2 * t;
    const c = 3 * mt * t2;
    const d = t2 * t;
    return {
      x: Math.round((a * p0.x) + (b * p1.x) + (c * p2.x) + (d * p3.x)),
      y: Math.round((a * p0.y) + (b * p1.y) + (c * p2.y) + (d * p3.y)),
    };
  }
}
