import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import {
  RgbaColor,
  SurfaceClipRect,
  FontState,
  PenState,
  RenderStats,
  ProtocolDebugRendererOptions,
  withVisibleAlpha,
} from './types';
import { PixelSurface } from './pixel-surface';
import { encodeRgbaPng } from './png-encoder';
import { intersectClipRects, parseRectFromTwoPoints } from './geometry';
import {
  parseFillColorCommand,
  parsePenStyleCommand,
  parseFontCommand,
  parseAreaStyleCommand,
  parseVisualizationNamespace,
  parseRenderParameterCommand,
  parseClipRectCommand,
  parseCornerRadiusCommand,
  parseCursorStyleCommand,
  parseLayerSwitchCommand,
} from './state-parsers';
import {
  parsePrimitiveCommand,
  parseFill3dRectCommand,
  parsePolygonCommand,
  parsePointsCommand,
} from './shape-commands';
import { TextRenderer } from './text-commands';
import {
  ImageLoader,
  resolveChromaKey,
  shouldSkipImage,
  resolveImageStyle,
  normalizeImageGeometry,
} from './image-commands';
import {
  extractDrawImages,
  PaintCommand,
} from '../protocol/paint-commands';
import { getPaintCommandReferenceName } from '../protocol/command-registry';
import {
  CMD_CLEAR_RECT,
  CMD_CLEAR_RECT_ALT,
  CMD_CLEAR_ALL,
  CMD_DRAW_IMAGE,
  CMD_DRAW_POINTS,
  CMD_DRAW_POLYGON,
  CMD_DRAW_POLYGON_FLOAT,
  CMD_DRAW_PRIMITIVE,
  CMD_DRAW_PRIMITIVE_FLOAT_QUAD,
  CMD_DRAW_PRIMITIVE_FLOAT_RECT,
  CMD_DRAW_SHAPE,
  CMD_DRAW_TEXT,
  CMD_DRAW_TEXT_LEGACY,
  CMD_DRAW_TEXT_LEGACY_UTF16,
  CMD_DRAW_TEXT_UTF16,
  CMD_FILL_3D_RECT,
  CMD_INIT_VISUALIZATION,
  CMD_LAYER_SWITCH,
  CMD_RESTORE_CLIP_RECT,
  CMD_SET_AREA_STYLE,
  CMD_SET_AREA_STYLE_LEGACY,
  CMD_SET_CLIP_RECT,
  CMD_SET_COMPOSITE_MODE,
  CMD_SET_CURSOR_STYLE,
  CMD_SET_CORNER_RADIUS,
  CMD_SET_FILL_COLOR,
  CMD_SET_FONT,
  CMD_SET_PEN_STYLE,
  CMD_SET_RENDER_PARAMETER,
  CMD_TOUCH_HANDLING_FLAGS,
  CMD_TOUCH_RECTANGLES,
} from '../protocol/command-ids';
import { ProtocolPaintFrame } from '../protocol/client';

const logger = pino({ name: 'protocol-debug-renderer' });

export class ProtocolDebugRenderer {
  private readonly options: ProtocolDebugRendererOptions;
  private readonly sessionDir: string;
  private readonly timelinePath: string;
  private readonly backgroundColor: RgbaColor = { r: 255, g: 255, b: 255, a: 255 };
  private readonly transparentColor: RgbaColor = { r: 0, g: 0, b: 0, a: 0 };
  private readonly surface: PixelSurface;
  private readonly layers = new Map<number, PixelSurface>();
  private activeLayerId = -1;
  private readonly imageLoader: ImageLoader | null;
  private readonly textRenderer = new TextRenderer();
  private warnedUnhandledCommandIds = new Set<number>();
  private visualizationNamespace = '';
  private renderParameters = new Map<number, number>();
  private writeQueue: Promise<void> = Promise.resolve();
  private frameCount = 0;
  private droppedFrames = 0;
  private maxFrameWarningShown = false;
  private lastCapturedAtMs = 0;
  private latestPng: Buffer | null = null;
  private lastPersistedPngHash: string | null = null;
  private skippedDuplicateFrames = 0;
  private closed = false;

  constructor(options: ProtocolDebugRendererOptions) {
    this.options = {
      ...options,
      width: Math.max(1, options.width),
      height: Math.max(1, options.height),
      maxFrames: Math.max(1, options.maxFrames),
      minIntervalMs: Math.max(0, options.minIntervalMs),
    };

    this.imageLoader = options.imageSource?.enabled
      ? new ImageLoader(options.imageSource)
      : null;

    this.surface = new PixelSurface(
      this.options.width,
      this.options.height,
      this.backgroundColor,
    );

    if (this.options.noDisk) {
      this.sessionDir = '';
      this.timelinePath = '';
      logger.debug({ width: this.options.width, height: this.options.height }, 'Protocol paint renderer initialized (no-disk mode)');
    } else {
      const stamp = this.formatFileTimestamp(new Date());
      this.sessionDir = path.resolve(this.options.outputDir, `session-${stamp}`);
      fs.mkdirSync(this.sessionDir, { recursive: true });
      this.timelinePath = path.join(this.sessionDir, 'timeline.ndjson');
      const sessionMeta = {
        startedAt: new Date().toISOString(),
        outputDir: this.sessionDir,
        width: this.options.width,
        height: this.options.height,
        maxFrames: this.options.maxFrames,
        minIntervalMs: this.options.minIntervalMs,
        includeEmptyFrames: this.options.includeEmptyFrames,
        imageSource: options.imageSource
          ? {
            enabled: options.imageSource.enabled,
            host: options.imageSource.host,
            port: options.imageSource.port,
            basePath: options.imageSource.basePath,
            timeoutMs: options.imageSource.timeoutMs,
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
    // Ensure queued async frame applications are reflected in preview output.
    await this.writeQueue;
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

    if (this.options.noDisk) {
      const commands = [...frame.commands];
      this.writeQueue = this.writeQueue
        .then(() => this.applyCommands(commands))
        .then(() => {})
        .catch((error) => {
          logger.debug({ error }, 'Failed to apply commands in no-disk renderer');
        });
      return;
    }

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
    if (!this.options.noDisk) {
      const summary = {
        finishedAt: new Date().toISOString(),
        capturedFrames: this.frameCount,
        droppedFrames: this.droppedFrames,
        skippedDuplicateFrames: this.skippedDuplicateFrames,
        latestFrameAvailable: this.latestPng !== null,
      };
      try {
        await fs.promises.writeFile(path.join(this.sessionDir, 'summary.json'), JSON.stringify(summary, null, 2));
      } catch (error) {
        logger.warn({ error }, 'Failed to write protocol debug renderer summary');
      }
    }
    this.imageLoader?.destroy();
  }

  private activeSurface(): PixelSurface {
    if (this.activeLayerId === -1) {
      return this.surface;
    }
    return this.getOrCreateLayer(this.activeLayerId);
  }

  private getOrCreateLayer(layerId: number): PixelSurface {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = new PixelSurface(this.options.width, this.options.height, this.transparentColor);
      this.layers.set(layerId, layer);
    }
    return layer;
  }

  private clearColor(): RgbaColor {
    return this.activeLayerId === -1 ? this.backgroundColor : this.transparentColor;
  }

  private async persistFrame(index: number, frame: ProtocolPaintFrame): Promise<void> {
    const stats = await this.applyCommands(frame.commands);
    const png = this.renderCurrentSurface(
      frame.requestEvent?.eventTag,
      frame.requestEvent ? { x: frame.requestEvent.x, y: frame.requestEvent.y } : undefined,
    );
    this.latestPng = Buffer.from(png);

    const pngHash = crypto.createHash('md5').update(png).digest('hex');
    if (pngHash === this.lastPersistedPngHash) {
      this.skippedDuplicateFrames++;
      return;
    }
    this.lastPersistedPngHash = pngHash;

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
    this.activeLayerId = -1;
    let currentFill: RgbaColor = { r: 255, g: 255, b: 255, a: 255 };
    let fillDisabled = false;
    let currentPen: PenState = {
      color: { r: 0, g: 0, b: 0, a: 255 },
      width: 1,
      strokeEnabled: true,
      lineStyle: 0,
      lineCap: 'butt',
      lineJoin: 'miter',
      miterLimit: 1.5,
      dashPattern: null,
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
        const fill = parseFillColorCommand(command);
        if (fill) {
          currentFill = fill.color;
          fillDisabled = fill.disabled;
        }
        continue;
      }

      if (command.id === CMD_SET_PEN_STYLE) {
        const parsedPen = parsePenStyleCommand(command);
        if (parsedPen) {
          currentPen = parsedPen;
        }
        continue;
      }

      if (command.id === CMD_SET_FONT) {
        const parsedFont = parseFontCommand(command, currentFont);
        if (parsedFont) {
          currentFont = parsedFont;
        }
        continue;
      }

      if (command.id === CMD_SET_AREA_STYLE || command.id === CMD_SET_AREA_STYLE_LEGACY) {
        const areaStyle = parseAreaStyleCommand(command);
        if (areaStyle) {
          currentFill = areaStyle.fillColor;
          fillDisabled = areaStyle.fillDisabled;
          currentPen = {
            ...currentPen,
            color: areaStyle.borderColor,
          };
        }
        continue;
      }

      if (command.id === CMD_LAYER_SWITCH) {
        const layerId = parseLayerSwitchCommand(command);
        if (layerId !== null) {
          this.activeLayerId = layerId;
        }
        continue;
      }

      if (command.id === CMD_SET_CLIP_RECT) {
        const nextClip = parseClipRectCommand(command);
        if (nextClip) {
          if (clipRect) {
            clipStack.push(clipRect);
            clipRect = intersectClipRects(clipRect, nextClip)
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
        const cornerRadius = parseCornerRadiusCommand(command);
        if (cornerRadius) {
          cornerRadiusX = cornerRadius.x;
          cornerRadiusY = cornerRadius.y;
        }
        continue;
      }

      if (command.id === CMD_SET_CURSOR_STYLE) {
        parseCursorStyleCommand(command);
        continue;
      }

      if (command.id === CMD_INIT_VISUALIZATION) {
        const namespace = parseVisualizationNamespace(command);
        if (namespace) {
          this.visualizationNamespace = namespace;
        }
        continue;
      }

      if (command.id === CMD_TOUCH_HANDLING_FLAGS || command.id === CMD_TOUCH_RECTANGLES) {
        continue;
      }

      if (command.id === CMD_SET_RENDER_PARAMETER) {
        const parameter = parseRenderParameterCommand(command);
        if (parameter) {
          this.renderParameters.set(parameter.id, parameter.value);
        }
        continue;
      }

      if (command.id === CMD_SET_COMPOSITE_MODE) {
        continue;
      }

      if (command.id === CMD_DRAW_POLYGON || command.id === CMD_DRAW_POLYGON_FLOAT) {
        const polygon = parsePolygonCommand(command);
        if (polygon && polygon.points.length >= 2) {
          const surface = this.activeSurface();
          const shouldFill = polygon.mode === 0 && !fillDisabled;
          const shouldStroke = currentPen.strokeEnabled;
          if (shouldFill && polygon.points.length >= 3) {
            surface.fillPolygon(polygon.points, withVisibleAlpha(currentFill), clipRect ?? undefined);
          }
          if (shouldStroke) {
            if (polygon.mode === 0) {
              surface.strokePolygon(
                polygon.points,
                withVisibleAlpha(currentPen.color),
                currentPen.width,
                clipRect ?? undefined,
                currentPen.dashPattern,
                currentPen.lineCap,
                currentPen.lineJoin,
              );
            } else if (polygon.mode === 2) {
              surface.strokeBezierPolyline(
                polygon.points,
                withVisibleAlpha(currentPen.color),
                currentPen.width,
                clipRect ?? undefined,
                currentPen.dashPattern,
                currentPen.lineCap,
              );
            } else {
              surface.strokePolyline(
                polygon.points,
                withVisibleAlpha(currentPen.color),
                currentPen.width,
                clipRect ?? undefined,
                currentPen.dashPattern,
                currentPen.lineCap,
                currentPen.lineJoin,
              );
            }
          }
        }
        continue;
      }

      if (command.id === CMD_FILL_3D_RECT) {
        const parsed = parseFill3dRectCommand(command);
        if (!parsed) continue;
        const surface = this.activeSurface();
        // Reference Fill3DRect always fills with its own color (not currentFill),
        // does NOT check fillDisabled/wm(), and uses lineWidth=1 for borders.
        surface.fillRect(
          parsed.x,
          parsed.y,
          parsed.width,
          parsed.height,
          withVisibleAlpha(parsed.color),
          clipRect ?? undefined,
        );
        surface.strokeRect(
          parsed.x,
          parsed.y,
          parsed.width,
          parsed.height,
          withVisibleAlpha(parsed.color),
          1,
          clipRect ?? undefined,
        );
        continue;
      }

      if (command.id === CMD_DRAW_POINTS) {
        const points = parsePointsCommand(command);
        if (!points || fillDisabled) {
          continue;
        }
        const surface = this.activeSurface();
        const color = withVisibleAlpha(currentFill);
        for (const point of points) {
          surface.fillRect(point.x, point.y, 1, 1, color, clipRect ?? undefined);
        }
        continue;
      }

      if (
        command.id === CMD_DRAW_SHAPE
        || command.id === CMD_DRAW_PRIMITIVE
        || command.id === CMD_DRAW_PRIMITIVE_FLOAT_QUAD
        || command.id === CMD_DRAW_PRIMITIVE_FLOAT_RECT
      ) {
        const primitive = parsePrimitiveCommand(command);
        if (!primitive) continue;
        const surface = this.activeSurface();
        const strokeColor = withVisibleAlpha(currentPen.color);
        const fillColor = withVisibleAlpha(currentFill);
        const shouldFill = !fillDisabled;

        if (primitive.kind === 3) {
          if (currentPen.strokeEnabled) {
            surface.drawLine(
              primitive.x,
              primitive.y + primitive.height - 1,
              primitive.x + primitive.width - 1,
              primitive.y,
              strokeColor,
              currentPen.width,
              clipRect ?? undefined,
              currentPen.dashPattern,
              currentPen.lineCap,
            );
          }
          continue;
        }

        if (primitive.kind === 4) {
          if (currentPen.strokeEnabled) {
            surface.drawLine(
              primitive.x,
              primitive.y,
              primitive.x + primitive.width - 1,
              primitive.y + primitive.height - 1,
              strokeColor,
              currentPen.width,
              clipRect ?? undefined,
              currentPen.dashPattern,
              currentPen.lineCap,
            );
          }
          continue;
        }

        if (primitive.kind === 2) {
          if (shouldFill) {
            surface.fillEllipse(
              primitive.x,
              primitive.y,
              primitive.width,
              primitive.height,
              fillColor,
              clipRect ?? undefined,
            );
          }
          if (currentPen.strokeEnabled) {
            surface.strokeEllipse(
              primitive.x,
              primitive.y,
                primitive.width,
                primitive.height,
                strokeColor,
                currentPen.width,
                clipRect ?? undefined,
                currentPen.dashPattern,
                currentPen.lineCap,
              );
            }
            continue;
        }

        if (primitive.kind === 1) {
          if (shouldFill) {
            surface.fillRoundedRect(
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
            surface.strokeRoundedRect(
              primitive.x,
              primitive.y,
              primitive.width,
              primitive.height,
              cornerRadiusX,
                cornerRadiusY,
                strokeColor,
                currentPen.width,
                clipRect ?? undefined,
                currentPen.dashPattern,
                currentPen.lineCap,
                currentPen.lineJoin,
              );
            }
            continue;
        }

        if (shouldFill) {
          surface.fillRect(
            primitive.x,
            primitive.y,
            primitive.width,
            primitive.height,
            fillColor,
            clipRect ?? undefined,
          );
        }
        if (currentPen.strokeEnabled) {
          surface.strokeRect(
            primitive.x,
            primitive.y,
            primitive.width,
            primitive.height,
            strokeColor,
            currentPen.width,
            clipRect ?? undefined,
            currentPen.dashPattern,
            currentPen.lineCap,
            currentPen.lineJoin,
          );
        }
        continue;
      }

      if (command.id === CMD_CLEAR_RECT || command.id === CMD_CLEAR_RECT_ALT) {
        const parsed = parseRectFromTwoPoints(command);
        if (!parsed) continue;
        this.activeSurface().clearRect(
          parsed.x,
          parsed.y,
          parsed.width,
          parsed.height,
          this.clearColor(),
          clipRect ?? undefined,
        );
        continue;
      }

      if (command.id === CMD_CLEAR_ALL) {
        this.activeSurface().clearRect(0, 0, this.options.width, this.options.height, this.clearColor(), clipRect ?? undefined);
        continue;
      }

      if (command.id === CMD_DRAW_IMAGE) {
        const parsedImage = extractDrawImages([command])[0];
        if (!parsedImage) continue;
        const image = normalizeImageGeometry(parsedImage);
        processedImageCount++;

        if (shouldSkipImage(image.imageId, image.width, image.height, image.flags, image.tintColor, this.options.width, this.options.height)) {
          skippedImageCount++;
          if (skippedImageIds.length < 12) {
            skippedImageIds.push(image.imageId);
          }
          continue;
        }

        let renderedFromSource = false;
        if (this.imageLoader) {
          const external = await this.imageLoader.resolveExternalImage(image.imageId);
          if (external) {
            this.activeSurface().blitRgbaImage(
              external.data,
              external.width,
              external.height,
              image.x,
              image.y,
              image.width,
              image.height,
              resolveChromaKey(image.flags, image.tintColor, !!external.isSvg),
              clipRect ?? undefined,
            );
            renderedFromSource = true;
          }
        }

        if (!renderedFromSource) {
          const surface = this.activeSurface();
          const style = resolveImageStyle(image.imageId, image.flags, image.tintColor);
          if (style.fill) {
            surface.fillRect(image.x, image.y, image.width, image.height, style.fill, clipRect ?? undefined);
          }
          surface.strokeRect(image.x, image.y, image.width, image.height, style.border, 1, clipRect ?? undefined);
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
        const label = this.textRenderer.parseTextDrawCommand(
          command,
          command.id === CMD_DRAW_TEXT_LEGACY_UTF16 || command.id === CMD_DRAW_TEXT_UTF16,
          command.id === CMD_DRAW_TEXT_LEGACY || command.id === CMD_DRAW_TEXT_LEGACY_UTF16,
        );
        if (!label) continue;
        this.textRenderer.renderTextLabel(
          this.activeSurface(),
          label,
          currentFont,
          clipRect ?? undefined,
        );
        textLabelCount++;
        continue;
      }

      this.warnUnhandledPaintCommand(command);
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
    // Composite layers onto base surface clone.
    // Order: base (white bg) → highest layer ID first → layer 0 last (foreground on top).
    const frame = this.surface.clone();

    if (this.layers.size > 0) {
      const sortedIds = [...this.layers.keys()].sort((a, b) => b - a);
      for (const layerId of sortedIds) {
        const layer = this.layers.get(layerId)!;
        frame.blitRgbaImage(
          layer.pixels,
          layer.width,
          layer.height,
          0, 0,
          layer.width,
          layer.height,
          null,
        );
      }
    }

    const stripe = this.getEventStripeColor(eventTag);

    // Crop to content bounds before encoding to eliminate empty viewport whitespace.
    const bounds = frame.contentBounds();
    const output = bounds
      ? frame.crop(bounds.x, bounds.y, bounds.width, bounds.height)
      : frame;

    output.fillRect(0, 0, output.width, 4, stripe);
    if (eventPosition) {
      const marker = { r: 245, g: 86, b: 86, a: 255 };
      const ex = eventPosition.x - (bounds?.x ?? 0);
      const ey = eventPosition.y - (bounds?.y ?? 0);
      output.strokeRect(ex - 3, ey - 3, 7, 7, marker, 1);
      output.fillRect(ex - 1, ey - 1, 3, 3, marker);
    }
    return encodeRgbaPng(output.width, output.height, output.pixels);
  }

  private buildCommandHistogram(commands: PaintCommand[]): Record<number, number> {
    const histogram: Record<number, number> = {};
    for (const command of commands) {
      histogram[command.id] = (histogram[command.id] ?? 0) + 1;
    }
    return histogram;
  }

  private warnUnhandledPaintCommand(command: PaintCommand): void {
    if (this.warnedUnhandledCommandIds.has(command.id)) {
      return;
    }
    this.warnedUnhandledCommandIds.add(command.id);
    const referenceName = getPaintCommandReferenceName(command.id);
    logger.warn(
      {
        commandId: command.id,
        commandName: referenceName ?? undefined,
        size: command.size,
        dataLength: command.data.length,
      },
      'Unhandled paint command encountered',
    );
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
