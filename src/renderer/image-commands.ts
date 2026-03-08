import https from 'https';
import pino from 'pino';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { Resvg } from '@resvg/resvg-js';
import {
  RgbaColor,
  DecodedRasterImage,
  ProtocolDebugRendererOptions,
  mixColor,
  hashText,
} from './types';
import { ImageDrawCommand } from '../protocol/paint-commands';

const logger = pino({ name: 'renderer-image-loader' });

type ImageSourceConfig = NonNullable<ProtocolDebugRendererOptions['imageSource']>;

export class ImageLoader {
  private readonly source: ImageSourceConfig;
  private readonly agent: https.Agent;
  private imagePoolLoadPromise: Promise<void> | null = null;
  private imagePoolPathById = new Map<string, string>();
  private imageCache = new Map<string, Promise<DecodedRasterImage | null>>();

  constructor(source: ImageSourceConfig) {
    this.source = source;
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 2,
      rejectUnauthorized: source.rejectUnauthorized,
    });
  }

  async resolveExternalImage(imageId: string): Promise<DecodedRasterImage | null> {
    if (!this.source.enabled) {
      return null;
    }
    const normalizedId = normalizeImageId(imageId);
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

  destroy(): void {
    this.agent.destroy();
  }

  private async loadExternalImage(normalizedId: string, originalId: string): Promise<DecodedRasterImage | null> {
    await this.ensureImagePoolLoaded();
    const candidates = this.buildImageFetchCandidates(normalizedId, originalId);
    for (const candidate of candidates) {
      const fetched = await this.fetchImageBytes(candidate);
      if (!fetched) continue;
      const decoded = decodeRasterImage(fetched.body, fetched.contentType);
      if (decoded) {
        return decoded;
      }
    }
    return null;
  }

  private async ensureImagePoolLoaded(): Promise<void> {
    if (!this.source.enabled) {
      return;
    }
    if (this.imagePoolLoadPromise) {
      await this.imagePoolLoadPromise;
      return;
    }
    this.imagePoolLoadPromise = (async () => {
      const csvPath = joinBasePath(this.source.basePath, 'application.imagepoolcollection.csv');
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
      const namespace = normalizeImageLookupKey(cols[0] ?? '');
      const project = normalizeImageLookupKey(cols[1] ?? '');
      const name = normalizeImageLookupKey(cols[2] ?? '');
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
    const candidates: string[] = [];
    const add = (candidate: string) => {
      if (!candidate) return;
      if (candidates.includes(candidate)) return;
      candidates.push(candidate);
    };

    add(`/ImageByImagePoolId?id=${encodeURIComponent(originalId)}`);
    add(`/ImageByImagePoolId?id=${encodeURIComponent(normalizedId)}`);
    add(`${normalizeBasePath(this.source.basePath)}/ImageByImagePoolId?id=${encodeURIComponent(originalId)}`);
    add(`${normalizeBasePath(this.source.basePath)}/ImageByImagePoolId?id=${encodeURIComponent(normalizedId)}`);

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

  private normalizeResourcePath(rawPath: string): string {
    const pathOnly = rawPath.split('?')[0]?.trim() ?? rawPath.trim();
    if (!pathOnly) {
      return joinBasePath(this.source.basePath, 'missing-resource');
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
    return joinBasePath(this.source.basePath, normalized);
  }

  private async fetchImageBytes(pathname: string): Promise<{ body: Buffer; contentType: string } | null> {
    return new Promise((resolve) => {
      const request = https.request(
        {
          hostname: this.source.host,
          port: this.source.port,
          path: pathname,
          method: 'GET',
          timeout: Math.max(50, this.source.timeoutMs),
          agent: this.agent,
          headers: {
            Accept: '*/*',
            Referer: this.source.referer,
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
}

// --- Image style & filtering utilities ---

export function normalizeImageId(imageId: string): string {
  return imageId.toLowerCase().replace(/\x00+$/g, '').trim();
}

export function normalizeImageGeometry(image: ImageDrawCommand): ImageDrawCommand {
  const { x, y } = image;
  let { width, height } = image;
  width = Math.max(1, Math.abs(width));
  height = Math.max(1, Math.abs(height));
  return { ...image, x, y, width, height };
}

/**
 * Resolve the chroma key color for an image.
 * In webvisu.js (Gb.Rx), flag 0x20 means the color is a transparency/chroma key:
 * pixels matching this color are made fully transparent. SVG images are exempt.
 */
export function resolveChromaKey(
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

export function shouldSkipImage(
  imageId: string,
  width: number,
  height: number,
  flags: number,
  tintColor: { r: number; g: number; b: number; a: number },
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  const id = normalizeImageId(imageId);

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
  const isLarge = width >= Math.floor(canvasWidth * 0.35) && height >= Math.floor(canvasHeight * 0.35);
  const hasChromaKey = (flags & 0x20) !== 0 && (tintColor.r > 0 || tintColor.g > 0 || tintColor.b > 0);
  if (isLarge && hasChromaKey) {
    return true;
  }

  return false;
}

export function resolveImageStyle(
  imageId: string,
  flags: number,
  tintColor: { r: number; g: number; b: number; a: number },
): { fill: RgbaColor | null; border: RgbaColor } {
  const normalizedId = imageId.toLowerCase().replace(/\x00+$/g, '').trim();

  // Flag 0x20 is a chroma key (transparency color), not a tint — don't use it as fill color.
  // Fall back to deterministic hash-based color for unresolved images.
  const hash = hashText(normalizedId);
  const r = 70 + (hash & 0x5f);
  const g = 70 + ((hash >> 7) & 0x5f);
  const b = 70 + ((hash >> 14) & 0x5f);
  const base: RgbaColor = { r, g, b, a: 255 };

  // Unknown image assets are rendered as outlines only, avoiding solid cursor-like blocks.
  return {
    fill: null,
    border: mixColor(base, { r: 245, g: 245, b: 245, a: 255 }, 0.2),
  };
}

// --- Internal helpers ---

function normalizeBasePath(basePath: string): string {
  const trimmed = (basePath || '').trim();
  if (!trimmed) return '';
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return normalized.replace(/\/+$/g, '');
}

function joinBasePath(basePath: string, leaf: string): string {
  const normalizedBase = normalizeBasePath(basePath);
  if (!normalizedBase) {
    return `/${leaf.replace(/^\/+/, '')}`;
  }
  return `${normalizedBase}/${leaf.replace(/^\/+/, '')}`;
}

function normalizeImageLookupKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/\x00+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeRasterImage(buffer: Buffer, contentType: string): DecodedRasterImage | null {
  try {
    if (looksLikePng(buffer, contentType)) {
      const decoded = PNG.sync.read(buffer);
      return {
        width: decoded.width,
        height: decoded.height,
        data: new Uint8Array(decoded.data),
      };
    }

    if (looksLikeJpeg(buffer, contentType)) {
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

    if (looksLikeSvg(buffer, contentType)) {
      const decoded = decodeSvgImage(buffer);
      if (decoded) {
        return decoded;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function looksLikePng(buffer: Buffer, contentType: string): boolean {
  if (contentType.includes('image/png')) return true;
  if (buffer.length < 8) return false;
  return buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4E
    && buffer[3] === 0x47;
}

function looksLikeJpeg(buffer: Buffer, contentType: string): boolean {
  if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) return true;
  return buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8;
}

function looksLikeSvg(buffer: Buffer, contentType: string): boolean {
  if (contentType.includes('image/svg+xml')) return true;
  if (buffer.length === 0) return false;
  const probe = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('utf8').toLowerCase();
  return probe.includes('<svg');
}

function decodeSvgImage(buffer: Buffer): DecodedRasterImage | null {
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
