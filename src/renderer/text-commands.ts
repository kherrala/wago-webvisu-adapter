import {
  FontState,
  TextDrawCommand,
  DecodedRasterImage,
  SurfaceClipRect,
} from './types';
import { parseQuadRect, normalizeClipRectFromPoints } from './geometry';
import { PixelSurface } from './pixel-surface';
import { PaintCommand } from '../protocol/paint-commands';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';

export class TextRenderer {
  private cache = new Map<string, DecodedRasterImage>();

  parseTextDrawCommand(command: PaintCommand, utf16: boolean, legacyQuadRect: boolean): TextDrawCommand | null {
    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    let flags = 0;
    let textLen = 0;
    let textOffset = 0;
    const dv = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);

    if (legacyQuadRect) {
      const rect = parseQuadRect(command, 0, false);
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

  renderTextLabel(surface: PixelSurface, label: TextDrawCommand, font: FontState, clip?: SurfaceClipRect): void {
    const rect = normalizeClipRectFromPoints(label.left, label.top, label.right, label.bottom);
    if (rect.width <= 0 || rect.height <= 0 || !label.text) {
      return;
    }
    const raster = this.rasterizeText(label.text, rect.width, rect.height, label.flags, font);
    if (!raster) {
      return;
    }
    surface.blitRgbaImage(
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
    const cached = this.cache.get(key);
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
    const escapedFamily = escapeSvgText(font.family);
    const escapedText = escapeSvgText(text);

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
      this.cache.set(key, raster);
      if (this.cache.size > 2048) {
        this.cache.clear();
      }
      return raster;
    } catch {
      return null;
    }
  }
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
