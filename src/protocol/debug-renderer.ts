import fs from 'fs';
import https from 'https';
import path from 'path';
import zlib from 'zlib';
import pino from 'pino';
import {
  CMD_CLEAR_RECT,
  CMD_DRAW_IMAGE,
  CMD_FILL_3D_RECT,
  CMD_SET_FILL_COLOR,
  extractDrawImages,
  ImageDrawCommand,
  PaintCommand,
} from './paint-commands';
import { ProtocolPaintFrame } from './client';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { Resvg } from '@resvg/resvg-js';

const logger = pino({ name: 'protocol-debug-renderer' });

const CMD_DRAW_SHAPE = 1;
const CMD_DRAW_POLYGON = 2;
const CMD_DRAW_TEXT_LEGACY = 3;
const CMD_DRAW_TEXT_LEGACY_UTF16 = 11;
const CMD_DRAW_TEXT = 46;
const CMD_DRAW_TEXT_UTF16 = 47;
const CMD_SET_PEN_STYLE = 5;
const CMD_SET_FONT = 6;
const CMD_SET_CLIP_RECT = 8;
const CMD_RESTORE_CLIP_RECT = 9;
const CMD_LAYER_SWITCH = 18;
const CMD_DRAW_POINTS = 44;
const CMD_DRAW_PRIMITIVE = 45;
const CMD_SET_AREA_STYLE_LEGACY = 30;
const CMD_SET_AREA_STYLE = 48;
const CMD_DRAW_POLYGON_FLOAT = 59;
const CMD_DRAW_PRIMITIVE_FLOAT_QUAD = 60;
const CMD_DRAW_PRIMITIVE_FLOAT_RECT = 61;
const CMD_INIT_VISUALIZATION = 37;
const CMD_TOUCH_RECTANGLES = 42;
const CMD_SET_RENDER_PARAMETER = 66;
const CMD_SET_CORNER_RADIUS = 73;
const CMD_CLEAR_RECT_ALT = 93;
const CMD_CLEAR_ALL = 105;
const CMD_SET_COMPOSITE_MODE = 106;

interface SurfaceClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SurfacePoint {
  x: number;
  y: number;
}

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface RenderStats {
  processedImageCount: number;
  skippedImageCount: number;
  skippedImageIds: string[];
  imageCount: number;
  textLabelCount: number;
  commandHistogram: Record<number, number>;
}

interface DecodedRasterImage {
  width: number;
  height: number;
  data: Uint8Array;
  isSvg?: boolean;
}

interface FontState {
  family: string;
  size: number;
  color: RgbaColor;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
}

interface TextDrawCommand {
  left: number;
  top: number;
  right: number;
  bottom: number;
  flags: number;
  text: string;
}

type PrimitiveShapeKind = 0 | 1 | 2 | 3 | 4;

export interface ProtocolDebugRendererOptions {
  outputDir: string;
  width: number;
  height: number;
  maxFrames: number;
  minIntervalMs: number;
  includeEmptyFrames: boolean;
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

export class ProtocolDebugRenderer {
  private readonly options: ProtocolDebugRendererOptions;
  private readonly sessionDir: string;
  private readonly timelinePath: string;
  private readonly backgroundColor: RgbaColor = { r: 255, g: 255, b: 255, a: 255 };
  private readonly surface: PixelSurface;
  private readonly imageSource: NonNullable<ProtocolDebugRendererOptions['imageSource']> | null;
  private readonly imageSourceAgent: https.Agent | null;
  private imagePoolLoadPromise: Promise<void> | null = null;
  private imagePoolPathById = new Map<string, string>();
  private imageCache = new Map<string, Promise<DecodedRasterImage | null>>();
  private textRasterCache = new Map<string, DecodedRasterImage>();
  private visualizationNamespace = '';
  private renderParameters = new Map<number, number>();
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
    this.imageSource = options.imageSource ?? null;
    this.imageSourceAgent = this.imageSource
      ? new https.Agent({
        keepAlive: true,
        maxSockets: 2,
        rejectUnauthorized: this.imageSource.rejectUnauthorized,
      })
      : null;

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
      imageSource: this.imageSource
        ? {
          enabled: this.imageSource.enabled,
          host: this.imageSource.host,
          port: this.imageSource.port,
          basePath: this.imageSource.basePath,
          timeoutMs: this.imageSource.timeoutMs,
        }
        : null,
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

  async renderPreview(commands: PaintCommand[]): Promise<Buffer> {
    await this.applyCommands(commands);
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
    this.imageSourceAgent?.destroy();
  }

  private async persistFrame(index: number, frame: ProtocolPaintFrame): Promise<void> {
    const stats = await this.applyCommands(frame.commands);
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
      processedImageCount: stats.processedImageCount,
      skippedImageCount: stats.skippedImageCount,
      skippedImageIds: stats.skippedImageIds,
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

  private async applyCommands(commands: PaintCommand[]): Promise<RenderStats> {
    let currentFill: RgbaColor = { r: 255, g: 255, b: 255, a: 255 };
    let fillDisabled = false;
    let currentPen: { color: RgbaColor; width: number; strokeEnabled: boolean } = {
      color: { r: 0, g: 0, b: 0, a: 255 },
      width: 1,
      strokeEnabled: true,
    };
    let currentFont: FontState = {
      family: 'Arial',
      size: 12,
      color: currentPen.color,
      bold: false,
      italic: false,
      underline: false,
      strikeout: false,
    };
    let clipRect: SurfaceClipRect | null = null;
    const clipStack: SurfaceClipRect[] = [];
    let cornerRadiusX = -1;
    let cornerRadiusY = -1;
    let imageCount = 0;
    let processedImageCount = 0;
    let skippedImageCount = 0;
    const skippedImageIds: string[] = [];
    let textLabelCount = 0;

    for (const command of commands) {
      if (command.id === CMD_SET_FILL_COLOR) {
        const fill = this.parseFillColorCommand(command);
        if (fill) {
          currentFill = fill.color;
          fillDisabled = fill.disabled;
        }
        continue;
      }

      if (command.id === CMD_SET_PEN_STYLE) {
        const parsedPen = this.parsePenStyleCommand(command);
        if (parsedPen) {
          currentPen = parsedPen;
        }
        continue;
      }

      if (command.id === CMD_SET_FONT) {
        const parsedFont = this.parseFontCommand(command, currentFont);
        if (parsedFont) {
          currentFont = parsedFont;
        }
        continue;
      }

      if (command.id === CMD_SET_AREA_STYLE || command.id === CMD_SET_AREA_STYLE_LEGACY) {
        const areaStyle = this.parseAreaStyleCommand(command);
        if (areaStyle) {
          currentFill = areaStyle.fillColor;
          fillDisabled = areaStyle.fillDisabled;
        }
        continue;
      }

      if (command.id === CMD_LAYER_SWITCH) {
        // The browser toggles between layer contexts here. The debug renderer keeps one cumulative surface.
        continue;
      }

      if (command.id === CMD_SET_CLIP_RECT) {
        const nextClip = this.parseClipRectCommand(command);
        if (nextClip) {
          if (clipRect) {
            clipStack.push(clipRect);
            // When intersection is empty, use a zero-size rect so nothing draws
            // (null would mean "no clip" = everything visible, which is wrong).
            clipRect = this.intersectClipRects(clipRect, nextClip)
              ?? { x: 0, y: 0, width: 0, height: 0 };
          } else {
            clipRect = nextClip;
          }
        }
        continue;
      }

      if (command.id === CMD_RESTORE_CLIP_RECT) {
        clipRect = clipStack.pop() ?? null;
        continue;
      }

      if (command.id === CMD_SET_CORNER_RADIUS) {
        const cornerRadius = this.parseCornerRadiusCommand(command);
        if (cornerRadius) {
          cornerRadiusX = cornerRadius.x;
          cornerRadiusY = cornerRadius.y;
        }
        continue;
      }

      if (command.id === CMD_INIT_VISUALIZATION) {
        const namespace = this.parseVisualizationNamespace(command);
        if (namespace) {
          this.visualizationNamespace = namespace;
        }
        continue;
      }

      if (command.id === CMD_TOUCH_RECTANGLES) {
        // Touch metadata updates hit testing only; no visual effect.
        continue;
      }

      if (command.id === CMD_SET_RENDER_PARAMETER) {
        const parameter = this.parseRenderParameterCommand(command);
        if (parameter) {
          this.renderParameters.set(parameter.id, parameter.value);
        }
        continue;
      }

      if (command.id === CMD_SET_COMPOSITE_MODE) {
        // Supported modes in webvisu.js are copy/source-over. For the cumulative debug canvas
        // we keep source-over behavior.
        continue;
      }

      if (command.id === CMD_DRAW_POLYGON || command.id === CMD_DRAW_POLYGON_FLOAT) {
        const polygon = this.parsePolygonCommand(command);
        if (polygon && polygon.points.length >= 2) {
          const shouldFill = polygon.mode === 0 && !fillDisabled;
          const shouldStroke = currentPen.strokeEnabled;
          if (shouldFill && polygon.points.length >= 3) {
            this.surface.fillPolygon(polygon.points, this.withVisibleAlpha(currentFill), clipRect ?? undefined);
          }
          if (shouldStroke) {
            if (polygon.mode === 0) {
              this.surface.strokePolygon(
                polygon.points,
                this.withVisibleAlpha(currentPen.color),
                currentPen.width,
                clipRect ?? undefined,
              );
            } else {
              this.surface.strokePolyline(
                polygon.points,
                this.withVisibleAlpha(currentPen.color),
                currentPen.width,
                clipRect ?? undefined,
              );
            }
          }
        }
        continue;
      }

      if (command.id === CMD_FILL_3D_RECT) {
        const parsed = this.parseFill3dRectCommand(command);
        if (!parsed) continue;
        const color = parsed.color ?? currentFill;
        if (!fillDisabled) {
          this.surface.fillRect(
            parsed.x,
            parsed.y,
            parsed.width,
            parsed.height,
            this.withVisibleAlpha(color),
            clipRect ?? undefined,
          );
        }
        if (currentPen.strokeEnabled) {
          this.surface.strokeRect(
            parsed.x,
            parsed.y,
            parsed.width,
            parsed.height,
            this.withVisibleAlpha(currentPen.color),
            currentPen.width,
            clipRect ?? undefined,
          );
        }
        continue;
      }

      if (command.id === CMD_DRAW_POINTS) {
        const points = this.parsePointsCommand(command);
        if (!points || fillDisabled) {
          continue;
        }
        const color = this.withVisibleAlpha(currentFill);
        for (const point of points) {
          this.surface.fillRect(point.x, point.y, 1, 1, color, clipRect ?? undefined);
        }
        continue;
      }

      if (
        command.id === CMD_DRAW_SHAPE
        || command.id === CMD_DRAW_PRIMITIVE
        || command.id === CMD_DRAW_PRIMITIVE_FLOAT_QUAD
        || command.id === CMD_DRAW_PRIMITIVE_FLOAT_RECT
      ) {
        const primitive = this.parsePrimitiveCommand(command);
        if (!primitive) continue;
        const strokeColor = this.withVisibleAlpha(currentPen.color);
        const fillColor = this.withVisibleAlpha(currentFill);
        const shouldFill = !fillDisabled;

        if (primitive.kind === 3) {
          if (currentPen.strokeEnabled) {
            this.surface.drawLine(
              primitive.x,
              primitive.y + primitive.height - 1,
              primitive.x + primitive.width - 1,
              primitive.y,
              strokeColor,
              currentPen.width,
              clipRect ?? undefined,
            );
          }
          continue;
        }

        if (primitive.kind === 4) {
          if (currentPen.strokeEnabled) {
            this.surface.drawLine(
              primitive.x,
              primitive.y,
              primitive.x + primitive.width - 1,
              primitive.y + primitive.height - 1,
              strokeColor,
              currentPen.width,
              clipRect ?? undefined,
            );
          }
          continue;
        }

        if (primitive.kind === 2) {
          if (shouldFill) {
            this.surface.fillEllipse(
              primitive.x,
              primitive.y,
              primitive.width,
              primitive.height,
              fillColor,
              clipRect ?? undefined,
            );
          }
          if (currentPen.strokeEnabled) {
            this.surface.strokeEllipse(
              primitive.x,
              primitive.y,
              primitive.width,
              primitive.height,
              strokeColor,
              currentPen.width,
              clipRect ?? undefined,
            );
          }
          continue;
        }

        if (primitive.kind === 1) {
          if (shouldFill) {
            this.surface.fillRoundedRect(
              primitive.x,
              primitive.y,
              primitive.width,
              primitive.height,
              cornerRadiusX,
              cornerRadiusY,
              fillColor,
              clipRect ?? undefined,
            );
          }
          if (currentPen.strokeEnabled) {
            this.surface.strokeRoundedRect(
              primitive.x,
              primitive.y,
              primitive.width,
              primitive.height,
              cornerRadiusX,
              cornerRadiusY,
              strokeColor,
              currentPen.width,
              clipRect ?? undefined,
            );
          }
          continue;
        }

        if (shouldFill) {
          this.surface.fillRect(
            primitive.x,
            primitive.y,
            primitive.width,
            primitive.height,
            fillColor,
            clipRect ?? undefined,
          );
        }
        if (currentPen.strokeEnabled) {
          this.surface.strokeRect(
            primitive.x,
            primitive.y,
            primitive.width,
            primitive.height,
            strokeColor,
            currentPen.width,
            clipRect ?? undefined,
          );
        }
        continue;
      }

      if (command.id === CMD_CLEAR_RECT || command.id === CMD_CLEAR_RECT_ALT) {
        const parsed = this.parseRectFromTwoPoints(command);
        if (!parsed) continue;
        this.surface.clearRect(
          parsed.x,
          parsed.y,
          parsed.width,
          parsed.height,
          this.backgroundColor,
          clipRect ?? undefined,
        );
        if (command.id === CMD_CLEAR_RECT_ALT) {
          clipRect = this.normalizeClipRect(parsed.x, parsed.y, parsed.width, parsed.height);
        }
        continue;
      }

      if (command.id === CMD_CLEAR_ALL) {
        this.surface.clearRect(
          0,
          0,
          this.options.width,
          this.options.height,
          this.backgroundColor,
          clipRect ?? undefined,
        );
        continue;
      }

      if (command.id === CMD_DRAW_IMAGE) {
        const parsedImage = extractDrawImages([command])[0];
        if (!parsedImage) continue;
        const image = this.normalizeImageGeometry(parsedImage);
        processedImageCount++;

        if (this.shouldSkipImage(image.imageId, image.width, image.height, image.flags, image.tintColor)) {
          skippedImageCount++;
          if (skippedImageIds.length < 12) {
            skippedImageIds.push(image.imageId);
          }
          continue;
        }

        let renderedFromSource = false;
        const external = await this.resolveExternalImage(image.imageId);
        if (external) {
          this.surface.blitRgbaImage(
            external.data,
            external.width,
            external.height,
            image.x,
            image.y,
            image.width,
            image.height,
            this.resolveChromaKey(image.flags, image.tintColor, !!external.isSvg),
            clipRect ?? undefined,
          );
          renderedFromSource = true;
        }

        if (!renderedFromSource) {
          const style = this.resolveImageStyle(image.imageId, image.flags, image.tintColor);
          if (style.fill) {
            this.surface.fillRect(image.x, image.y, image.width, image.height, style.fill, clipRect ?? undefined);
          }
          this.surface.strokeRect(image.x, image.y, image.width, image.height, style.border, 1, clipRect ?? undefined);
        }
        imageCount++;
        continue;
      }

      if (
        command.id === CMD_DRAW_TEXT_LEGACY
        || command.id === CMD_DRAW_TEXT_LEGACY_UTF16
        || command.id === CMD_DRAW_TEXT
        || command.id === CMD_DRAW_TEXT_UTF16
      ) {
        const label = this.parseTextDrawCommand(
          command,
          command.id === CMD_DRAW_TEXT_LEGACY_UTF16 || command.id === CMD_DRAW_TEXT_UTF16,
          command.id === CMD_DRAW_TEXT_LEGACY || command.id === CMD_DRAW_TEXT_LEGACY_UTF16,
        );
        if (!label) continue;
        this.renderTextLabel(
          label,
          currentFont,
          clipRect ?? undefined,
        );
        textLabelCount++;
        continue;
      }
    }

    return {
      processedImageCount,
      skippedImageCount,
      skippedImageIds,
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

  private parseFillColorCommand(command: PaintCommand): { color: RgbaColor; disabled: boolean } | null {
    if (command.data.length < 8) {
      return null;
    }
    const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
    const flags = dv.getUint32(0, true);
    return {
      color: this.withVisibleAlpha(this.argbToColor(dv.getUint32(4, true))),
      disabled: (flags & 0x1) !== 0,
    };
  }

  private parsePenStyleCommand(command: PaintCommand): { color: RgbaColor; width: number; strokeEnabled: boolean } | null {
    if (command.data.length < 10) {
      return null;
    }
    const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
    const lineStyle = dv.getUint32(0, true);
    const widthRaw = Math.max(0, dv.getUint16(8, true));
    const color = this.withVisibleAlpha(this.argbToColor(dv.getUint32(4, true)));
    return {
      color,
      width: Math.max(1, Math.min(8, widthRaw || 1)),
      strokeEnabled: lineStyle <= 5,
    };
  }

  private parseFontCommand(command: PaintCommand, fallback: FontState): FontState | null {
    if (command.data.length < 12) {
      return null;
    }
    const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
    const color = this.withVisibleAlpha(this.argbToColor(dv.getUint32(0, true)));
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
      bold: (styleFlags & 0x1) !== 0,
      italic: (styleFlags & 0x2) !== 0,
      underline: (styleFlags & 0x4) !== 0,
      strikeout: (styleFlags & 0x8) !== 0,
    };
  }

  private parseAreaStyleCommand(command: PaintCommand): { fillColor: RgbaColor; fillDisabled: boolean } | null {
    if (command.data.length < 12) {
      return null;
    }
    const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
    const fillDisabled = dv.getUint32(0, true) === 1;
    const fillColor = this.withVisibleAlpha(this.argbToColor(dv.getUint32(4, true)));
    return { fillColor, fillDisabled };
  }

  private parseVisualizationNamespace(command: PaintCommand): string | null {
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

  private parseRenderParameterCommand(command: PaintCommand): { id: number; value: number } | null {
    if (command.data.length < 8) {
      return null;
    }
    const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
    return {
      id: dv.getUint16(0, true),
      value: dv.getInt32(4, true),
    };
  }

  private parseClipRectCommand(command: PaintCommand): SurfaceClipRect | null {
    return this.parseRectFromTwoPoints(command, 0, false);
  }

  private parseCornerRadiusCommand(command: PaintCommand): { x: number; y: number } | null {
    if (command.data.length < 4) {
      return null;
    }
    const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
    return {
      x: dv.getInt16(0, true),
      y: dv.getInt16(2, true),
    };
  }

  private parseTextDrawCommand(command: PaintCommand, utf16: boolean, legacyQuadRect: boolean): TextDrawCommand | null {
    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    let flags = 0;
    let textLen = 0;
    let textOffset = 0;
    const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);

    if (legacyQuadRect) {
      const rect = this.parseQuadRect(command, 0, false);
      if (!rect || command.data.length < 22) {
        return null;
      }
      left = rect.x;
      top = rect.y;
      right = rect.x + rect.width - 1;
      bottom = rect.y + rect.height - 1;
      flags = dv.getUint32(16, true);
      textLen = dv.getUint16(20, true);
      textOffset = 22;
    } else {
      if (command.data.length < 14) {
        return null;
      }
      left = dv.getInt16(0, true);
      top = dv.getInt16(2, true);
      right = dv.getInt16(4, true);
      bottom = dv.getInt16(6, true);
      flags = dv.getUint32(8, true);
      textLen = dv.getUint16(12, true);
      textOffset = 14;
    }

    const available = command.data.length - textOffset;
    if (available <= 0) {
      return null;
    }
    let text = '';
    if (utf16) {
      const byteLength = textLen * 2 <= available ? textLen * 2 : Math.min(textLen, available);
      if (byteLength <= 0) {
        return null;
      }
      text = Buffer
        .from(command.data.subarray(textOffset, textOffset + byteLength))
        .toString('utf16le')
        .replace(/\x00+$/g, '');
    } else {
      if (textLen > available) {
        return null;
      }
      text = Buffer
        .from(command.data.subarray(textOffset, textOffset + textLen))
        .toString('latin1')
        .replace(/\x00+$/g, '');
    }
    return { left, top, right, bottom, flags, text };
  }

  private parsePolygonCommand(command: PaintCommand): { mode: number; points: SurfacePoint[] } | null {
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
      points.push({
        x,
        y,
      });
    }
    return { mode, points };
  }

  private parsePointsCommand(command: PaintCommand): SurfacePoint[] | null {
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

  private parsePrimitiveCommand(command: PaintCommand): {
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
      rect = this.parseRectFromTwoPoints(command, 2, false);
    } else if (command.id === CMD_DRAW_SHAPE) {
      rect = this.parseQuadRect(command, 2, false);
    } else if (command.id === CMD_DRAW_PRIMITIVE_FLOAT_QUAD) {
      rect = this.parseQuadRect(command, 2, true);
    } else if (command.id === CMD_DRAW_PRIMITIVE_FLOAT_RECT) {
      rect = this.parseRectFromTwoPoints(command, 2, true);
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

  private parseFill3dRectCommand(command: PaintCommand): {
    x: number;
    y: number;
    width: number;
    height: number;
    color?: RgbaColor;
  } | null {
    // Fill3DRect format: x(2) + y(2) + width(2) + height(2) [+ fillArgb(4) [+ highlightArgb(4) + shadowArgb(4)]]
    if (command.data.length < 8) {
      return null;
    }
    const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
    const x = dv.getInt16(0, true);
    const y = dv.getInt16(2, true);
    const width = dv.getInt16(4, true);
    const height = dv.getInt16(6, true);
    const rect = { x, y, width, height };

    if (command.data.length >= 12) {
      return { ...rect, color: this.withVisibleAlpha(this.argbToColor(dv.getUint32(8, true))) };
    }
    return rect;
  }

  private parseRectFromTwoPoints(
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
    return this.normalizeClipRectFromPoints(x1, y1, x2, y2);
  }

  private parseQuadRect(
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
    return this.normalizeClipRectFromPoints(
      Math.round(minX),
      Math.round(minY),
      Math.round(maxX),
      Math.round(maxY),
    );
  }

  private intersectClipRects(a: SurfaceClipRect, b: SurfaceClipRect): SurfaceClipRect | null {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width);
    const y1 = Math.min(a.y + a.height, b.y + b.height);
    if (x1 <= x0 || y1 <= y0) {
      return null;
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  private normalizeClipRect(x: number, y: number, width: number, height: number): SurfaceClipRect {
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

  private renderTextLabel(label: TextDrawCommand, font: FontState, clip?: SurfaceClipRect): void {
    const rect = this.normalizeClipRectFromPoints(label.left, label.top, label.right, label.bottom);
    if (rect.width <= 0 || rect.height <= 0 || !label.text) {
      return;
    }
    const raster = this.rasterizeText(label.text, rect.width, rect.height, label.flags, font);
    if (!raster) {
      return;
    }
    this.surface.blitRgbaImage(
      raster.data,
      raster.width,
      raster.height,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      null,
      clip,
    );
  }

  private rasterizeText(
    text: string,
    width: number,
    height: number,
    flags: number,
    font: FontState,
  ): DecodedRasterImage | null {
    const clippedWidth = Math.max(1, Math.min(4096, width));
    const clippedHeight = Math.max(1, Math.min(4096, height));
    const key = [
      text,
      clippedWidth,
      clippedHeight,
      flags >>> 0,
      font.family,
      font.size,
      font.bold ? 1 : 0,
      font.italic ? 1 : 0,
      font.underline ? 1 : 0,
      font.strikeout ? 1 : 0,
      font.color.r,
      font.color.g,
      font.color.b,
      font.color.a,
    ].join('|');
    const cached = this.textRasterCache.get(key);
    if (cached) {
      return cached;
    }

    const horizontalMode = flags & 0x3;
    const verticalCenter = (flags & 0x4) !== 0;
    const verticalBottom = (flags & 0x8) !== 0;
    const fontWeight = font.bold ? '700' : '400';
    const fontStyle = font.italic ? 'italic' : 'normal';
    const anchor = horizontalMode === 1 ? 'middle' : horizontalMode === 2 ? 'end' : 'start';
    const paddingX = Math.max(1, Math.round(font.size * 0.2));
    const x = horizontalMode === 1
      ? clippedWidth / 2
      : horizontalMode === 2
        ? clippedWidth - paddingX
        : paddingX;
    const y = verticalCenter
      ? (clippedHeight / 2)
      : verticalBottom
        ? Math.max(1, clippedHeight - Math.max(1, Math.round(font.size * 0.12)))
        : Math.max(1, Math.round(font.size * 0.9));
    const baseline = verticalCenter
      ? 'middle'
      : verticalBottom
        ? 'text-after-edge'
        : 'alphabetic';
    const fill = `rgba(${font.color.r},${font.color.g},${font.color.b},${Math.max(0, Math.min(255, font.color.a)) / 255})`;
    const escapedFamily = this.escapeSvgText(font.family);
    const escapedText = this.escapeSvgText(text);

    let decoration = '';
    if (font.underline && font.strikeout) {
      decoration = 'underline line-through';
    } else if (font.underline) {
      decoration = 'underline';
    } else if (font.strikeout) {
      decoration = 'line-through';
    }

    const decorationAttr = decoration ? ` text-decoration="${decoration}"` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${clippedWidth}" height="${clippedHeight}" viewBox="0 0 ${clippedWidth} ${clippedHeight}">
  <text x="${x}" y="${y}" fill="${fill}" font-family="${escapedFamily}" font-size="${Math.max(6, font.size)}" font-style="${fontStyle}" font-weight="${fontWeight}" text-anchor="${anchor}" dominant-baseline="${baseline}"${decorationAttr} xml:space="preserve">${escapedText}</text>
</svg>`;

    try {
      const rendered = new Resvg(svg, { background: 'rgba(0,0,0,0)' }).render();
      const png = rendered.asPng();
      const decoded = PNG.sync.read(png);
      const raster: DecodedRasterImage = {
        width: decoded.width,
        height: decoded.height,
        data: new Uint8Array(decoded.data),
      };
      this.textRasterCache.set(key, raster);
      if (this.textRasterCache.size > 2048) {
        this.textRasterCache.clear();
      }
      return raster;
    } catch {
      return null;
    }
  }

  private escapeSvgText(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private normalizeClipRectFromPoints(x1: number, y1: number, x2: number, y2: number): SurfaceClipRect {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1) + 1;
    const height = Math.abs(y2 - y1) + 1;
    return this.normalizeClipRect(left, top, width, height);
  }

  private normalizeImageGeometry(image: ImageDrawCommand): ImageDrawCommand {
    const { x, y } = image;
    let { width, height } = image;
    width = Math.max(1, Math.abs(width));
    height = Math.max(1, Math.abs(height));
    return { ...image, x, y, width, height };
  }

  private normalizeImageId(imageId: string): string {
    return imageId.toLowerCase().replace(/\x00+$/g, '').trim();
  }

  private normalizeImageLookupKey(key: string): string {
    return key
      .toLowerCase()
      .replace(/\x00+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async resolveExternalImage(imageId: string): Promise<DecodedRasterImage | null> {
    if (!this.imageSource?.enabled) {
      return null;
    }
    const normalizedId = this.normalizeImageId(imageId);
    if (!normalizedId) {
      return null;
    }
    let pending = this.imageCache.get(normalizedId);
    if (!pending) {
      pending = this.loadExternalImage(normalizedId, imageId);
      this.imageCache.set(normalizedId, pending);
    }
    try {
      return await pending;
    } catch {
      return null;
    }
  }

  private async loadExternalImage(normalizedId: string, originalId: string): Promise<DecodedRasterImage | null> {
    await this.ensureImagePoolLoaded();
    const candidates = this.buildImageFetchCandidates(normalizedId, originalId);
    for (const candidate of candidates) {
      const fetched = await this.fetchImageBytes(candidate);
      if (!fetched) continue;
      const decoded = this.decodeRasterImage(fetched.body, fetched.contentType);
      if (decoded) {
        return decoded;
      }
    }
    return null;
  }

  private async ensureImagePoolLoaded(): Promise<void> {
    if (!this.imageSource?.enabled) {
      return;
    }
    if (this.imagePoolLoadPromise) {
      await this.imagePoolLoadPromise;
      return;
    }
    this.imagePoolLoadPromise = (async () => {
      const source = this.imageSource!;
      const csvPath = this.joinBasePath(source.basePath, 'application.imagepoolcollection.csv');
      const fetched = await this.fetchImageBytes(csvPath);
      if (!fetched) {
        return;
      }
      const csvText = fetched.body.toString('latin1');
      this.indexImagePoolCsv(csvText);
      logger.info({ entries: this.imagePoolPathById.size }, 'Loaded protocol image pool map for debug renderer');
    })();
    await this.imagePoolLoadPromise;
  }

  private indexImagePoolCsv(csvText: string): void {
    const lines = csvText.replace(/\r\n/g, '\n').split('\n');
    for (const line of lines) {
      const cols = line.split(';');
      if (cols.length < 4) continue;
      const namespace = this.normalizeImageLookupKey(cols[0] ?? '');
      const project = this.normalizeImageLookupKey(cols[1] ?? '');
      const name = this.normalizeImageLookupKey(cols[2] ?? '');
      const rawPath = (cols[3] ?? '').trim();
      if (!name || !rawPath) continue;
      const namespaced = namespace ? `${namespace}.${name}` : name;
      const projectNamespaced = (project && namespace) ? `${project}.${namespace}.${name}` : '';
      this.imagePoolPathById.set(namespaced, rawPath);
      if (projectNamespaced) {
        this.imagePoolPathById.set(projectNamespaced, rawPath);
      }
      if (!this.imagePoolPathById.has(name)) {
        this.imagePoolPathById.set(name, rawPath);
      }
    }
  }

  private buildImageFetchCandidates(normalizedId: string, originalId: string): string[] {
    const source = this.imageSource!;
    const candidates: string[] = [];
    const add = (candidate: string) => {
      if (!candidate) return;
      if (candidates.includes(candidate)) return;
      candidates.push(candidate);
    };

    add(`/ImageByImagePoolId?id=${encodeURIComponent(originalId)}`);
    add(`/ImageByImagePoolId?id=${encodeURIComponent(normalizedId)}`);
    add(`${this.normalizeBasePath(source.basePath)}/ImageByImagePoolId?id=${encodeURIComponent(originalId)}`);
    add(`${this.normalizeBasePath(source.basePath)}/ImageByImagePoolId?id=${encodeURIComponent(normalizedId)}`);

    const lookupKeys = new Set<string>([
      normalizedId,
      normalizedId.replace(/^_+/, ''),
      normalizedId.split('.').slice(-2).join('.'),
      normalizedId.split('.').pop() ?? normalizedId,
    ]);
    for (const key of lookupKeys) {
      const mapped = this.imagePoolPathById.get(key);
      if (!mapped) continue;
      add(this.normalizeResourcePath(mapped));
    }

    return candidates;
  }

  private normalizeBasePath(basePath: string): string {
    const trimmed = (basePath || '').trim();
    if (!trimmed) return '';
    const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return normalized.replace(/\/+$/g, '');
  }

  private joinBasePath(basePath: string, leaf: string): string {
    const normalizedBase = this.normalizeBasePath(basePath);
    if (!normalizedBase) {
      return `/${leaf.replace(/^\/+/, '')}`;
    }
    return `${normalizedBase}/${leaf.replace(/^\/+/, '')}`;
  }

  private normalizeResourcePath(rawPath: string): string {
    const source = this.imageSource!;
    const pathOnly = rawPath.split('?')[0]?.trim() ?? rawPath.trim();
    if (!pathOnly) {
      return this.joinBasePath(source.basePath, 'missing-resource');
    }
    if (/^https?:\/\//i.test(pathOnly)) {
      try {
        const parsed = new URL(pathOnly);
        return parsed.pathname + (parsed.search || '');
      } catch {
        // Fall through to local normalization.
      }
    }
    const normalized = pathOnly.replace(/\\/g, '/');
    if (normalized.startsWith('/')) {
      return normalized;
    }
    return this.joinBasePath(source.basePath, normalized);
  }

  private async fetchImageBytes(pathname: string): Promise<{ body: Buffer; contentType: string } | null> {
    const source = this.imageSource;
    if (!source || !source.enabled || !this.imageSourceAgent) {
      return null;
    }

    return new Promise((resolve) => {
      const request = https.request(
        {
          hostname: source.host,
          port: source.port,
          path: pathname,
          method: 'GET',
          timeout: Math.max(50, source.timeoutMs),
          agent: this.imageSourceAgent!,
          headers: {
            Accept: '*/*',
            Referer: source.referer,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              resolve(null);
              return;
            }
            const body = Buffer.concat(chunks);
            if (body.length === 0) {
              resolve(null);
              return;
            }
            const rawContentType = response.headers['content-type'];
            const contentType = Array.isArray(rawContentType)
              ? rawContentType.join(';')
              : (rawContentType ?? '');
            resolve({ body, contentType: contentType.toLowerCase() });
          });
          response.on('error', () => resolve(null));
        },
      );

      request.on('timeout', () => {
        request.destroy();
        resolve(null);
      });
      request.on('error', () => resolve(null));
      request.end();
    });
  }

  private decodeRasterImage(buffer: Buffer, contentType: string): DecodedRasterImage | null {
    try {
      if (this.looksLikePng(buffer, contentType)) {
        const decoded = PNG.sync.read(buffer);
        return {
          width: decoded.width,
          height: decoded.height,
          data: new Uint8Array(decoded.data),
        };
      }

      if (this.looksLikeJpeg(buffer, contentType)) {
        const decoded = jpeg.decode(buffer, { useTArray: true });
        if (!decoded || !decoded.width || !decoded.height || !decoded.data) {
          return null;
        }
        return {
          width: decoded.width,
          height: decoded.height,
          data: decoded.data,
        };
      }

      if (this.looksLikeSvg(buffer, contentType)) {
        const decoded = this.decodeSvgImage(buffer);
        if (decoded) {
          return decoded;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private looksLikePng(buffer: Buffer, contentType: string): boolean {
    if (contentType.includes('image/png')) return true;
    if (buffer.length < 8) return false;
    return buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4E
      && buffer[3] === 0x47;
  }

  private looksLikeJpeg(buffer: Buffer, contentType: string): boolean {
    if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) return true;
    return buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8;
  }

  private looksLikeSvg(buffer: Buffer, contentType: string): boolean {
    if (contentType.includes('image/svg+xml')) return true;
    if (buffer.length === 0) return false;
    const probe = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('utf8').toLowerCase();
    return probe.includes('<svg');
  }

  private decodeSvgImage(buffer: Buffer): DecodedRasterImage | null {
    try {
      const svgText = buffer.toString('utf8');
      if (!svgText.toLowerCase().includes('<svg')) {
        return null;
      }
      const rendered = new Resvg(svgText, { background: 'rgba(0,0,0,0)' }).render();
      const png = rendered.asPng();
      const decoded = PNG.sync.read(png);
      return {
        width: decoded.width,
        height: decoded.height,
        data: new Uint8Array(decoded.data),
        isSvg: true,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve the chroma key color for an image.
   * In webvisu.js (Gb.Rx), flag 0x20 means the color is a transparency/chroma key:
   * pixels matching this color are made fully transparent. SVG images are exempt.
   */
  private resolveChromaKey(
    flags: number,
    tintColor: { r: number; g: number; b: number; a: number },
    isSvg: boolean,
  ): { r: number; g: number; b: number } | null {
    if ((flags & 0x20) === 0) {
      return null;
    }
    if (isSvg) {
      return null;
    }
    if (tintColor.r === 0 && tintColor.g === 0 && tintColor.b === 0) {
      return null;
    }
    return {
      r: tintColor.r,
      g: tintColor.g,
      b: tintColor.b,
    };
  }

  private shouldSkipImage(
    imageId: string,
    width: number,
    height: number,
    flags: number,
    tintColor: { r: number; g: number; b: number; a: number },
  ): boolean {
    const id = this.normalizeImageId(imageId);

    // Do not paint mouse cursor/pointer assets into diagnostic frames.
    if (
      id.includes('cursor')
      || id.includes('pointer')
      || id.includes('mouse')
      || id.includes('caret')
      || id.includes('hand')
    ) {
      return true;
    }

    // Guard against giant chroma-keyed overlays often caused by pointer sprites or transformed assets.
    const isLarge = width >= Math.floor(this.options.width * 0.35) && height >= Math.floor(this.options.height * 0.35);
    const hasChromaKey = (flags & 0x20) !== 0 && (tintColor.r > 0 || tintColor.g > 0 || tintColor.b > 0);
    if (isLarge && hasChromaKey) {
      return true;
    }

    return false;
  }

  private resolveImageStyle(
    imageId: string,
    flags: number,
    tintColor: { r: number; g: number; b: number; a: number },
  ): { fill: RgbaColor | null; border: RgbaColor } {
    const normalizedId = imageId.toLowerCase().replace(/\x00+$/g, '').trim();
    if (normalizedId.includes('element-lamp-lamp1-yellow-on')) {
      const color = { r: 252, g: 220, b: 84, a: 255 };
      return {
        fill: { ...color, a: 210 },
        border: this.mixColor(color, { r: 0, g: 0, b: 0, a: 255 }, 0.45),
      };
    }
    if (normalizedId.includes('element-lamp-lamp1-yellow-off')) {
      const color = { r: 120, g: 88, b: 42, a: 255 };
      return {
        fill: { ...color, a: 210 },
        border: this.mixColor(color, { r: 0, g: 0, b: 0, a: 255 }, 0.45),
      };
    }

    // Flag 0x20 is a chroma key (transparency color), not a tint — don't use it as fill color.
    // Fall back to deterministic hash-based color for unresolved images.
    const hash = this.hashText(normalizedId);
    const r = 70 + (hash & 0x5f);
    const g = 70 + ((hash >> 7) & 0x5f);
    const b = 70 + ((hash >> 14) & 0x5f);
    const base: RgbaColor = { r, g, b, a: 255 };

    // Unknown image assets are rendered as outlines only, avoiding solid cursor-like blocks.
    return {
      fill: null,
      border: this.mixColor(base, { r: 245, g: 245, b: 245, a: 255 }, 0.2),
    };
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
  ): void {
    const line = Math.max(1, Math.floor(thickness));
    this.fillRect(x, y, width, line, color, clip);
    this.fillRect(x, y + height - line, width, line, color, clip);
    this.fillRect(x, y, line, height, color, clip);
    this.fillRect(x + width - line, y, line, height, color, clip);
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
  ): void {
    if (radiusX <= 0 || radiusY <= 0) {
      this.strokeRect(x, y, width, height, color, thickness, clip);
      return;
    }
    this.strokeRect(x, y, width, height, color, thickness, clip);
  }

  drawLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: RgbaColor,
    thickness: number = 1,
    clip?: SurfaceClipRect,
  ): void {
    let cx0 = Math.round(x0);
    let cy0 = Math.round(y0);
    const cx1 = Math.round(x1);
    const cy1 = Math.round(y1);
    const dx = Math.abs(cx1 - cx0);
    const sx = cx0 < cx1 ? 1 : -1;
    const dy = -Math.abs(cy1 - cy0);
    const sy = cy0 < cy1 ? 1 : -1;
    let err = dx + dy;
    const size = Math.max(1, Math.floor(thickness));
    const half = Math.floor(size / 2);

    while (true) {
      this.fillRect(cx0 - half, cy0 - half, size, size, color, clip);
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
  }

  strokePolyline(points: SurfacePoint[], color: RgbaColor, thickness: number = 1, clip?: SurfaceClipRect): void {
    if (points.length < 2) {
      return;
    }
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      this.drawLine(a.x, a.y, b.x, b.y, color, thickness, clip);
    }
  }

  strokePolygon(points: SurfacePoint[], color: RgbaColor, thickness: number = 1, clip?: SurfaceClipRect): void {
    if (points.length < 2) {
      return;
    }
    this.strokePolyline(points, color, thickness, clip);
    this.drawLine(points[points.length - 1].x, points[points.length - 1].y, points[0].x, points[0].y, color, thickness, clip);
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
