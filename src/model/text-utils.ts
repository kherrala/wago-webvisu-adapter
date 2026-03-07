import { lightSwitchList } from '../config';

export function normalizeVisuText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\x00+$/g, '')
    .replace(/\s+/g, '')
    .trim();
}

export function resolveLightIndexFromLabel(text: string): number | null {
  const normalized = normalizeVisuText(text);
  if (!normalized) return null;
  for (const light of lightSwitchList) {
    if (normalizeVisuText(light.name) === normalized) return light.index;
    const plcLabel = (light as { plcLabel?: string }).plcLabel;
    if (plcLabel && normalizeVisuText(plcLabel) === normalized) return light.index;
  }
  return null;
}
