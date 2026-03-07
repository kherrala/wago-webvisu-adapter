import { config, uiCoordinates } from '../config';
import {
  PaintCommand,
  ImageDrawCommand,
  extractDrawImages,
} from '../protocol/paint-commands';
import { LAMP_IMAGE_OFF, LAMP_IMAGE_ON, normalizeImageId, isLampStatusImageId } from '../model/lamp-ids';

export { LAMP_IMAGE_OFF, LAMP_IMAGE_ON };

export function collectLampImages(commands: PaintCommand[]): ImageDrawCommand[] {
  return extractDrawImages(commands)
    .filter((image) => isLampStatusImageId(image.imageId))
    .slice(-36);
}

function isPlausibleLampGeometry(image: ImageDrawCommand): boolean {
  const viewportWidth = config.browser.viewport.width;
  const viewportHeight = config.browser.viewport.height;
  return image.width > 0 &&
    image.height > 0 &&
    image.width <= 160 &&
    image.height <= 160 &&
    image.x >= -120 &&
    image.y >= -120 &&
    image.x <= viewportWidth + 120 &&
    image.y <= viewportHeight + 120;
}

function imageCenterDistance(image: ImageDrawCommand, at: { x: number; y: number }): number {
  const centerX = image.x + (image.width / 2);
  const centerY = image.y + (image.height / 2);
  const dx = centerX - at.x;
  const dy = centerY - at.y;
  return Math.sqrt((dx * dx) + (dy * dy));
}

export function resolveIndicatorImages(commands: PaintCommand[]): {
  indicator1: ImageDrawCommand[];
  indicator2: ImageDrawCommand[];
  indicator3: ImageDrawCommand[];
} {
  const lamps = collectLampImages(commands);
  const indexed = lamps.map((image, index) => ({ image, index }));
  const used = new Set<number>();

  const indicators = [
    { key: 'indicator1' as const, at: uiCoordinates.lightSwitches.statusIndicator },
    { key: 'indicator2' as const, at: uiCoordinates.lightSwitches.statusIndicator2 },
    { key: 'indicator3' as const, at: uiCoordinates.lightSwitches.statusIndicator3 },
  ];

  const resolved: {
    indicator1: ImageDrawCommand[];
    indicator2: ImageDrawCommand[];
    indicator3: ImageDrawCommand[];
  } = {
    indicator1: [],
    indicator2: [],
    indicator3: [],
  };

  for (const indicator of indicators) {
    const candidate = indexed
      .filter((entry) => !used.has(entry.index))
      .filter((entry) => isPlausibleLampGeometry(entry.image))
      .map((entry) => ({
        entry,
        distance: imageCenterDistance(entry.image, indicator.at),
      }))
      .filter((entry) => entry.distance <= 24)
      .sort((a, b) => a.distance - b.distance || b.entry.index - a.entry.index)[0];

    if (candidate) {
      used.add(candidate.entry.index);
      resolved[indicator.key] = [candidate.entry.image];
    }
  }

  const unresolved = indicators.filter((indicator) => resolved[indicator.key].length === 0);
  const remaining = indexed
    .filter((entry) => !used.has(entry.index))
    .filter((entry) => isPlausibleLampGeometry(entry.image));
  if (unresolved.length > 0 && remaining.length > 0) {
    const ordered = remaining.length === unresolved.length
      ? [...remaining].sort((a, b) => a.index - b.index)
      : [...remaining].sort((a, b) => b.index - a.index);
    const count = Math.min(unresolved.length, ordered.length);
    for (let i = 0; i < count; i++) {
      resolved[unresolved[i].key] = [ordered[i].image];
    }
  }

  return resolved;
}

export function formatImageSummary(images: ImageDrawCommand[]): Array<{
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  return images.map((image) => ({
    id: image.imageId,
    x: image.x,
    y: image.y,
    width: image.width,
    height: image.height,
  }));
}

export function resolveLampStatus(images: ImageDrawCommand[]): boolean | null {
  if (images.length === 0) return null;
  for (let i = images.length - 1; i >= 0; i--) {
    const id = normalizeImageId(images[i].imageId);
    if (id === LAMP_IMAGE_ON) return true;
    if (id === LAMP_IMAGE_OFF) return false;
  }
  return null;
}
