import { GradientState, RgbaColor } from './types';

// ---- Geometry helpers ----

function toRadians(deg: number): number {
  return (Math.PI * deg) / 180;
}

/**
 * Tests whether the line from (ax,ay)→(bx,by) intersects the segment (cx,cy)→(dx,dy).
 * Direct port of GradientFill.fp() from webvisu-deobfuscated.js lines 675–682.
 */
function intersectsSegment(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
  dx: number, dy: number,
): boolean {
  const denom = (dy - cy) * (bx - ax) - (dx - cx) * (by - ay);
  const numA = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const numB = (bx - ax) * (ay - cy) - (by - ay) * (ax - cx);
  if (denom === 0) return numA === numB;
  const tA = numA / denom;
  const tB = numB / denom;
  return tA >= 0 && tA <= 1 && tB >= 0 && tB <= 1;
}

/**
 * Computes linear gradient endpoints (x0,y0)→(x1,y1) for a given bounding rect and angle.
 * Direct port of GradientFill.In() from webvisu-deobfuscated.js lines 640–664.
 * angle must be in the 0–180 range (already adjusted by the GradientFill constructor logic).
 */
function computeLinearEndpoints(
  left: number,
  top: number,
  right: number,
  bottom: number,
  angle: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const width = right - left;
  const height = bottom - top;
  const cx = left + width / 2;
  const cy = top + height / 2;
  const rad = angle > 90 ? toRadians(180 - angle) : toRadians(angle);
  const maxDim = Math.max(width, height);
  const farX = cx - maxDim * Math.cos(rad);
  const farY = cy - maxDim * Math.sin(rad);

  let x0: number;
  let y0: number;
  let x1: number;
  let y1: number;

  if (intersectsSegment(cx, cy, farX, farY, left, top, left, bottom)) {
    // Gradient line intersects the left edge
    let alpha = rad;
    let e = (width / 2) * Math.tan(alpha);
    e = height / 2 - e;
    const beta = Math.PI / 2 - alpha;
    const d = e * Math.cos(beta);
    const f = (d * d) / e;
    const g = e - f;
    const h = Math.sqrt(Math.max(0, g * f));
    x0 = left - h;
    y0 = top + g;
    x1 = right + h;
    y1 = bottom - g;
  } else if (intersectsSegment(cx, cy, farX, farY, left, top, right, top)) {
    // Gradient line intersects the top edge
    let alpha = rad;
    let e = (height / 2) / Math.tan(alpha);
    e = width / 2 - e;
    const beta = Math.PI / 2 - alpha;
    const d = Math.cos(beta) * e;
    const f = (d * d) / e;
    const h = Math.sqrt(Math.max(0, (e - f) * f));
    x0 = left + f;
    y0 = top - h;
    x1 = right - f;
    y1 = bottom + h;
  } else {
    x0 = left;
    y0 = top;
    x1 = right;
    y1 = bottom;
  }

  // Angle correction for angles > 90°
  if (angle > 90) {
    x0 = right - (x0 - left);
    x1 = right - (x1 - left);
  }

  return { x0, y0, x1, y1 };
}

// ---- Color interpolation ----

function interpolateColor(c1: RgbaColor, c2: RgbaColor, t: number): RgbaColor {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t),
    a: Math.round(c1.a + (c2.a - c1.a) * t),
  };
}

function linearT(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const gx = x1 - x0;
  const gy = y1 - y0;
  const len2 = gx * gx + gy * gy;
  if (len2 === 0) return 0;
  return Math.max(0, Math.min(1, ((px - x0) * gx + (py - y0) * gy) / len2));
}

// ---- Public API ----

/**
 * Returns the interpolated gradient color at pixel (px, py) given the
 * bounding rect of the shape being filled.
 */
export function sampleGradient(
  px: number,
  py: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  gradient: GradientState,
): RgbaColor {
  const { type, angle, centerX, centerY, color1, color2 } = gradient;

  if (type === 1) {
    // Radial gradient — center at fractional offsets, radius = farthest corner
    const w = right - left;
    const h = bottom - top;
    const cx = left + w * centerX;
    const cy = top + h * centerY;
    const maxRadius = Math.sqrt(
      Math.max(
        (left - cx) ** 2 + (top - cy) ** 2,
        (right - cx) ** 2 + (top - cy) ** 2,
        (right - cx) ** 2 + (bottom - cy) ** 2,
        (left - cx) ** 2 + (bottom - cy) ** 2,
      ),
    );
    if (maxRadius === 0) return color1;
    const t = Math.min(1, Math.sqrt((px - cx) ** 2 + (py - cy) ** 2) / maxRadius);
    return interpolateColor(color1, color2, t);
  }

  // Linear (type 0) or reflected (type 2)
  const { x0, y0, x1, y1 } = computeLinearEndpoints(left, top, right, bottom, angle);
  const t = linearT(px, py, x0, y0, x1, y1);

  if (type === 2) {
    // Reflected: color1 @ 0, color2 @ 0.45–0.55, color1 @ 1
    if (t <= 0.45) {
      return interpolateColor(color1, color2, t / 0.45);
    } else if (t <= 0.55) {
      return color2;
    } else {
      return interpolateColor(color2, color1, (t - 0.55) / 0.45);
    }
  }

  return interpolateColor(color1, color2, t);
}
