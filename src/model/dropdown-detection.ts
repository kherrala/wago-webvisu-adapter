import { PaintCommand, extractTextLabels } from '../protocol/paint-commands';
import { UIState } from './ui-state';
import { normalizeVisuText } from './text-utils';
import { extractDropdownLabels, resolveDropdownView } from './dropdown-labels';
import pino from 'pino';

const logger = pino({ name: 'dropdown-detection' });

export function isDropdownOpen(commands: PaintCommand[]): boolean {
  const labels = extractDropdownLabels(commands);
  return labels.length >= 3;
}

export function isDropdownLikelyClosed(commands: PaintCommand[]): boolean {
  const labels = extractTextLabels(commands);
  return labels.some(l => normalizeVisuText(l.text) === 'ohjaus');
}

export function isDropdownDefinitivelyClosed(commands: PaintCommand[]): boolean {
  return isDropdownLikelyClosed(commands) && !isDropdownOpen(commands);
}

export function didPressLeaveDropdownOpen(
  downCommands: PaintCommand[],
  settledCommands: PaintCommand[],
): boolean {
  if (isDropdownOpen(settledCommands)) return true;
  if (isDropdownDefinitivelyClosed(settledCommands)) return false;
  return isDropdownOpen(downCommands);
}

export function syncDropdownStateFromCommands(
  commands: PaintCommand[],
  state: UIState,
  reason: string,
): boolean {
  const view = resolveDropdownView(commands);
  if (!view) return false;

  const previousFirstVisible = state.dropdownFirstVisible;
  state.applyDropdownView(view);

  if (previousFirstVisible !== view.firstVisible) {
    const handleCenterY = state.getDropdownScrollY(view.firstVisible);
    const handleTop = Math.round(handleCenterY - 4);
    const handleBottom = handleTop + 9;
    logger.info({
      reason,
      firstVisible: view.firstVisible,
      handleCenterY: Math.round(handleCenterY),
      handleTopY: handleTop,
      handleBottomY: handleBottom,
      labels: view.labels.slice(0, 5),
    }, 'Detected dropdown scrollbar handle');
  }
  return true;
}
