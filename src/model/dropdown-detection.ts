import { PaintCommand } from '../protocol/paint-commands';
import { classifyFrame, THRESHOLD_DROPDOWN_OPEN, THRESHOLD_DROPDOWN_CLOSED } from '../protocol/frame-classifier';
import { UIState } from './ui-state';
import { resolveDropdownView } from './dropdown-labels';
import pino from 'pino';

const logger = pino({ name: 'dropdown-detection' });

export function isDropdownOpen(commands: PaintCommand[]): boolean {
  return classifyFrame(commands).dropdownOpen >= THRESHOLD_DROPDOWN_OPEN;
}

export function isDropdownDefinitivelyClosed(commands: PaintCommand[]): boolean {
  return classifyFrame(commands).dropdownClosed >= THRESHOLD_DROPDOWN_CLOSED;
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
