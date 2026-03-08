export interface SurfaceClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfacePoint {
  x: number;
  y: number;
}

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface RenderStats {
  processedImageCount: number;
  skippedImageCount: number;
  skippedImageIds: string[];
  imageCount: number;
  textLabelCount: number;
  commandHistogram: Record<number, number>;
}

export interface DecodedRasterImage {
  width: number;
  height: number;
  data: Uint8Array;
  isSvg?: boolean;
}

export interface FontState {
  family: string;
  size: number;
  color: RgbaColor;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
}

export interface PenState {
  color: RgbaColor;
  width: number;
  strokeEnabled: boolean;
  lineStyle: number;
  lineCap: 'butt' | 'square' | 'round';
  lineJoin: 'miter' | 'bevel' | 'round';
  miterLimit: number;
  dashPattern: number[] | null;
}

export interface TextDrawCommand {
  left: number;
  top: number;
  right: number;
  bottom: number;
  flags: number;
  text: string;
}

export type PrimitiveShapeKind = 0 | 1 | 2 | 3 | 4;

export interface ProtocolDebugRendererOptions {
  outputDir: string;
  width: number;
  height: number;
  maxFrames: number;
  minIntervalMs: number;
  includeEmptyFrames: boolean;
  /** When true, skip all disk I/O. The surface still accumulates commands for on-demand renderPreview(). */
  noDisk?: boolean;
  imageSource?: {
    enabled: boolean;
    host: string;
    port: number;
    rejectUnauthorized: boolean;
    referer: string;
    basePath: string;
    timeoutMs: number;
  };
}

// --- Color utilities ---

export function argbToColor(argb: number): RgbaColor {
  return {
    a: (argb >>> 24) & 0xFF,
    r: (argb >>> 16) & 0xFF,
    g: (argb >>> 8) & 0xFF,
    b: argb & 0xFF,
  };
}

export function withVisibleAlpha(color: RgbaColor): RgbaColor {
  if (color.a === 0) {
    return { ...color, a: 255 };
  }
  return color;
}

export function mixColor(base: RgbaColor, overlay: RgbaColor, weight: number): RgbaColor {
  const clampedWeight = Math.max(0, Math.min(1, weight));
  const inv = 1 - clampedWeight;
  return {
    r: Math.round((base.r * inv) + (overlay.r * clampedWeight)),
    g: Math.round((base.g * inv) + (overlay.g * clampedWeight)),
    b: Math.round((base.b * inv) + (overlay.b * clampedWeight)),
    a: 255,
  };
}

export function hashText(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
