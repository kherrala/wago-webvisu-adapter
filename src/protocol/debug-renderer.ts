import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import pino from 'pino';
import {
  CMD_CLEAR_RECT,
  CMD_FILL_3D_RECT,
  CMD_SET_FILL_COLOR,
  extractDrawImages,
  extractTextLabels,
  PaintCommand,
} from './paint-commands';
import { ProtocolPaintFrame } from './client';

const logger = pino({ name: 'protocol-debug-renderer' });

const CMD_CLEAR_RECT_AND_CLIP = 93;

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface RenderStats {
  imageCount: number;
  textLabelCount: number;
  commandHistogram: Record<number, number>;
}

export interface ProtocolDebugRendererOptions {
  outputDir: string;
  width: number;
  height: number;
  maxFrames: number;
  minIntervalMs: number;
  includeEmptyFrames: boolean;
}

export class ProtocolDebugRenderer {
  private readonly options: ProtocolDebugRendererOptions;
  private readonly sessionDir: string;
  private readonly timelinePath: string;
  private readonly backgroundColor: RgbaColor = { r: 10, g: 14, b: 20, a: 255 };
  private readonly surface: PixelSurface;
  private writeQueue: Promise<void> = Promise.resolve();
  private frameCount = 0;
  private droppedFrames = 0;
  private maxFrameWarningShown = false;
  private lastCapturedAtMs = 0;
  private latestPng: Buffer | null = null;
  private closed = false;

  constructor(options: ProtocolDebugRendererOptions) {
    this.options = {
      ...options,
      width: Math.max(1, options.width),
      height: Math.max(1, options.height),
      maxFrames: Math.max(1, options.maxFrames),
      minIntervalMs: Math.max(0, options.minIntervalMs),
    };

    const stamp = this.formatFileTimestamp(new Date());
    this.sessionDir = path.resolve(this.options.outputDir, `session-${stamp}`);
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.timelinePath = path.join(this.sessionDir, 'timeline.ndjson');
    this.surface = new PixelSurface(
      this.options.width,
      this.options.height,
      this.backgroundColor,
    );
    const sessionMeta = {
      startedAt: new Date().toISOString(),
      outputDir: this.sessionDir,
      width: this.options.width,
      height: this.options.height,
      maxFrames: this.options.maxFrames,
      minIntervalMs: this.options.minIntervalMs,
      includeEmptyFrames: this.options.includeEmptyFrames,
    };
    fs.writeFileSync(path.join(this.sessionDir, 'session.json'), JSON.stringify(sessionMeta, null, 2));

    logger.info({
      dir: this.sessionDir,
      width: this.options.width,
      height: this.options.height,
      maxFrames: this.options.maxFrames,
      minIntervalMs: this.options.minIntervalMs,
    }, 'Protocol paint debug renderer enabled');
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getLatestPng(): Buffer | null {
    if (!this.latestPng) {
      return null;
    }
    return Buffer.from(this.latestPng);
  }

  renderPreview(commands: PaintCommand[]): Buffer {
    this.applyCommands(commands);
    const png = this.renderCurrentSurface(undefined);
    this.latestPng = Buffer.from(png);
    return png;
  }

  record(frame: ProtocolPaintFrame): void {
    if (this.closed) {
      return;
    }

    if (!this.options.includeEmptyFrames && frame.commands.length === 0) {
      return;
    }

    if (this.options.minIntervalMs > 0 && this.lastCapturedAtMs > 0) {
      const deltaMs = frame.capturedAtMs - this.lastCapturedAtMs;
      if (deltaMs >= 0 && deltaMs < this.options.minIntervalMs) {
        return;
      }
    }

    if (this.frameCount >= this.options.maxFrames) {
      this.droppedFrames++;
      if (!this.maxFrameWarningShown) {
        this.maxFrameWarningShown = true;
        logger.warn({
          dir: this.sessionDir,
          maxFrames: this.options.maxFrames,
        }, 'Protocol debug renderer reached max frame limit; dropping additional frames');
      }
      return;
    }

    this.lastCapturedAtMs = frame.capturedAtMs;
    const index = ++this.frameCount;
    const snapshot: ProtocolPaintFrame = {
      ...frame,
      paint: { ...frame.paint },
      commands: [...frame.commands],
      ...(frame.requestEvent ? { requestEvent: { ...frame.requestEvent } } : {}),
    };

    this.writeQueue = this.writeQueue
      .then(() => this.persistFrame(index, snapshot))
      .catch((error) => {
        logger.warn({ error, index }, 'Failed to persist protocol debug frame');
      });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeQueue;
    const summary = {
      finishedAt: new Date().toISOString(),
      capturedFrames: this.frameCount,
      droppedFrames: this.droppedFrames,
      latestFrameAvailable: this.latestPng !== null,
    };
    try {
      await fs.promises.writeFile(path.join(this.sessionDir, 'summary.json'), JSON.stringify(summary, null, 2));
    } catch (error) {
      logger.warn({ error }, 'Failed to write protocol debug renderer summary');
    }
  }

  private async persistFrame(index: number, frame: ProtocolPaintFrame): Promise<void> {
    const stats = this.applyCommands(frame.commands);
    const png = this.renderCurrentSurface(
      frame.requestEvent?.eventTag,
      frame.requestEvent ? { x: frame.requestEvent.x, y: frame.requestEvent.y } : undefined,
    );
    this.latestPng = Buffer.from(png);

    const baseName = this.buildFrameBaseName(index, frame);
    const pngPath = path.join(this.sessionDir, `${baseName}.png`);
    const metaPath = path.join(this.sessionDir, `${baseName}.json`);

    const summary = {
      index,
      capturedAt: frame.capturedAt,
      capturedAtMs: frame.capturedAtMs,
      responseDurationMs: frame.responseDurationMs,
      httpStatus: frame.httpStatus,
      request: {
        requestType: frame.requestType,
        requestTypeName: frame.requestTypeName,
        serviceGroup: frame.serviceGroup,
        serviceId: frame.serviceId,
        serviceName: frame.serviceName,
        event: frame.requestEvent ?? null,
      },
      paint: frame.paint,
      commandCount: frame.commands.length,
      imageCount: stats.imageCount,
      textLabelCount: stats.textLabelCount,
      commandHistogram: stats.commandHistogram,
      files: {
        png: path.basename(pngPath),
        metadata: path.basename(metaPath),
      },
    };

    await fs.promises.writeFile(pngPath, png);
    await fs.promises.writeFile(metaPath, JSON.stringify(summary, null, 2));
    await fs.promises.appendFile(this.timelinePath, `${JSON.stringify(summary)}\n`);
  }

  private buildFrameBaseName(index: number, frame: ProtocolPaintFrame): string {
    const stamp = this.formatFileTimestamp(new Date(frame.capturedAtMs));
    const eventName = this.sanitizeFileToken(
      frame.requestEvent?.eventName
      || frame.serviceName
      || 'paint',
      'paint',
    );
    const position = frame.requestEvent
      ? `-x${frame.requestEvent.x}-y${frame.requestEvent.y}`
      : '';
    return `frame-${index.toString().padStart(5, '0')}-${stamp}-${eventName}${position}`;
  }

  private sanitizeFileToken(value: string, fallback: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '');
    return normalized || fallback;
  }

  private formatFileTimestamp(date: Date): string {
    const yyyy = date.getFullYear().toString().padStart(4, '0');
    const mm = (date.getMonth() + 1).toString().padStart(2, '0');
    const dd = date.getDate().toString().padStart(2, '0');
    const hh = date.getHours().toString().padStart(2, '0');
    const mi = date.getMinutes().toString().padStart(2, '0');
    const ss = date.getSeconds().toString().padStart(2, '0');
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return `${yyyy}${mm}${dd}-${hh}${mi}${ss}-${ms}`;
  }

  private applyCommands(commands: PaintCommand[]): RenderStats {
    let currentFill: RgbaColor = { r: 40, g: 48, b: 62, a: 255 };
    let imageCount = 0;
    let textLabelCount = 0;

    for (const command of commands) {
      if (command.id === CMD_SET_FILL_COLOR && command.data.length >= 4) {
        const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
        currentFill = this.withVisibleAlpha(this.argbToColor(dv.getUint32(0, true)));
        continue;
      }

      if (command.id === CMD_FILL_3D_RECT) {
        const parsed = this.parseRectCommand(command);
        if (!parsed) continue;
        const color = parsed.color ?? currentFill;
        this.surface.fillRect(parsed.x, parsed.y, parsed.width, parsed.height, this.withVisibleAlpha(color));
        continue;
      }

      if (command.id === CMD_CLEAR_RECT || command.id === CMD_CLEAR_RECT_AND_CLIP) {
        const parsed = this.parseRectCommand(command);
        if (!parsed) continue;
        this.surface.fillRect(parsed.x, parsed.y, parsed.width, parsed.height, this.withVisibleAlpha(currentFill));
        continue;
      }

      if (command.id === 19) {
        const image = extractDrawImages([command])[0];
        if (!image) continue;
        const base = this.resolveImageColor(image.imageId, image.flags, image.tintColor);
        const fill = { ...base, a: 220 };
        const border = this.mixColor(base, { r: 0, g: 0, b: 0, a: 255 }, 0.45);
        this.surface.fillRect(image.x, image.y, image.width, image.height, fill);
        this.surface.strokeRect(image.x, image.y, image.width, image.height, border, 1);
        imageCount++;
        continue;
      }

      if (command.id === 46) {
        const label = extractTextLabels([command])[0];
        if (!label) continue;
        const width = Math.max(1, label.right - label.left);
        const height = Math.max(1, label.bottom - label.top);
        this.surface.fillRect(label.left, label.top, width, height, { r: 28, g: 34, b: 44, a: 180 });
        this.surface.strokeRect(label.left, label.top, width, height, { r: 70, g: 220, b: 245, a: 235 }, 1);
        textLabelCount++;
      }
    }

    return {
      imageCount,
      textLabelCount,
      commandHistogram: this.buildCommandHistogram(commands),
    };
  }

  private renderCurrentSurface(eventTag?: number, eventPosition?: { x: number; y: number }): Buffer {
    const frame = this.surface.clone();
    const stripe = this.getEventStripeColor(eventTag);
    frame.fillRect(0, 0, this.options.width, 4, stripe);
    if (eventPosition) {
      const marker = { r: 245, g: 86, b: 86, a: 255 };
      frame.strokeRect(eventPosition.x - 3, eventPosition.y - 3, 7, 7, marker, 1);
      frame.fillRect(eventPosition.x - 1, eventPosition.y - 1, 3, 3, marker);
    }
    return encodeRgbaPng(frame.width, frame.height, frame.pixels);
  }

  private buildCommandHistogram(commands: PaintCommand[]): Record<number, number> {
    const histogram: Record<number, number> = {};
    for (const command of commands) {
      histogram[command.id] = (histogram[command.id] ?? 0) + 1;
    }
    return histogram;
  }

  private parseRectCommand(command: PaintCommand): {
    x: number;
    y: number;
    width: number;
    height: number;
    color?: RgbaColor;
  } | null {
    if (command.data.length < 8) {
      return null;
    }
    const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
    const rect = {
      x: dv.getInt16(0, true),
      y: dv.getInt16(2, true),
      width: dv.getInt16(4, true),
      height: dv.getInt16(6, true),
    };
    if (command.data.length >= 12) {
      const argb = dv.getUint32(8, true);
      return { ...rect, color: this.argbToColor(argb) };
    }
    return rect;
  }

  private resolveImageColor(
    imageId: string,
    flags: number,
    tintColor: { r: number; g: number; b: number; a: number },
  ): RgbaColor {
    const normalizedId = imageId.toLowerCase().replace(/\x00+$/g, '').trim();
    if (normalizedId.includes('element-lamp-lamp1-yellow-on')) {
      return { r: 252, g: 220, b: 84, a: 255 };
    }
    if (normalizedId.includes('element-lamp-lamp1-yellow-off')) {
      return { r: 120, g: 88, b: 42, a: 255 };
    }
    if ((flags & 0x20) !== 0 && (tintColor.r > 0 || tintColor.g > 0 || tintColor.b > 0)) {
      return { r: tintColor.r, g: tintColor.g, b: tintColor.b, a: 255 };
    }

    const hash = this.hashText(normalizedId);
    const r = 70 + (hash & 0x5f);
    const g = 70 + ((hash >> 7) & 0x5f);
    const b = 70 + ((hash >> 14) & 0x5f);
    return { r, g, b, a: 255 };
  }

  private hashText(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private mixColor(base: RgbaColor, overlay: RgbaColor, weight: number): RgbaColor {
    const clampedWeight = Math.max(0, Math.min(1, weight));
    const inv = 1 - clampedWeight;
    return {
      r: Math.round((base.r * inv) + (overlay.r * clampedWeight)),
      g: Math.round((base.g * inv) + (overlay.g * clampedWeight)),
      b: Math.round((base.b * inv) + (overlay.b * clampedWeight)),
      a: 255,
    };
  }

  private argbToColor(argb: number): RgbaColor {
    return {
      a: (argb >>> 24) & 0xFF,
      r: (argb >>> 16) & 0xFF,
      g: (argb >>> 8) & 0xFF,
      b: argb & 0xFF,
    };
  }

  private withVisibleAlpha(color: RgbaColor): RgbaColor {
    if (color.a === 0) {
      return { ...color, a: 255 };
    }
    return color;
  }

  private getEventStripeColor(eventTag?: number): RgbaColor {
    switch (eventTag) {
      case 2: // MouseDown
        return { r: 220, g: 105, b: 40, a: 255 };
      case 4: // MouseUp
        return { r: 55, g: 190, b: 80, a: 255 };
      case 16: // MouseMove
        return { r: 60, g: 120, b: 235, a: 255 };
      case 516: // ViewportInfo
        return { r: 175, g: 100, b: 230, a: 255 };
      case 1: // Heartbeat
        return { r: 120, g: 160, b: 180, a: 255 };
      default:
        return { r: 110, g: 110, b: 110, a: 255 };
    }
  }
}

class PixelSurface {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;

  constructor(width: number, height: number, background: RgbaColor) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    this.fillRect(0, 0, width, height, background);
  }

  clone(): PixelSurface {
    const cloned = new PixelSurface(this.width, this.height, { r: 0, g: 0, b: 0, a: 255 });
    cloned.pixels.set(this.pixels);
    return cloned;
  }

  fillRect(x: number, y: number, width: number, height: number, color: RgbaColor): void {
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
      return;
    }

    const x0 = Math.max(0, Math.floor(left));
    const y0 = Math.max(0, Math.floor(top));
    const x1 = Math.min(this.width, Math.ceil(left + rectWidth));
    const y1 = Math.min(this.height, Math.ceil(top + rectHeight));

    if (x0 >= x1 || y0 >= y1) {
      return;
    }

    const sourceAlpha = Math.max(0, Math.min(255, color.a)) / 255;
    const inverse = 1 - sourceAlpha;
    for (let py = y0; py < y1; py++) {
      let offset = ((py * this.width) + x0) * 4;
      for (let px = x0; px < x1; px++) {
        const dr = this.pixels[offset];
        const dg = this.pixels[offset + 1];
        const db = this.pixels[offset + 2];
        this.pixels[offset] = Math.round((color.r * sourceAlpha) + (dr * inverse));
        this.pixels[offset + 1] = Math.round((color.g * sourceAlpha) + (dg * inverse));
        this.pixels[offset + 2] = Math.round((color.b * sourceAlpha) + (db * inverse));
        this.pixels[offset + 3] = 255;
        offset += 4;
      }
    }
  }

  strokeRect(x: number, y: number, width: number, height: number, color: RgbaColor, thickness: number): void {
    const line = Math.max(1, Math.floor(thickness));
    this.fillRect(x, y, width, line, color);
    this.fillRect(x, y + height - line, width, line, color);
    this.fillRect(x, y, line, height, color);
    this.fillRect(x + width - line, y, line, height, color);
  }
}

function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0; // No filter
    const sourceStart = y * stride;
    for (let i = 0; i < stride; i++) {
      raw[rowOffset + 1 + i] = rgba[sourceStart + i];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // Compression method
  ihdr[11] = 0; // Filter method
  ihdr[12] = 0; // Interlace

  return Buffer.concat([
    signature,
    createPngChunk('IHDR', ihdr),
    createPngChunk('IDAT', compressed),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcValue = crc32(Buffer.concat([typeBuffer, data]));
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crcValue, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

const CRC32_TABLE = buildCrc32Table();

function crc32(input: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < input.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ input[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}
