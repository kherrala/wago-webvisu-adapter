import { uiCoordinates, lightSwitchList } from '../config';
import { PaintCommand, extractTextLabels } from '../protocol/paint-commands';
import { DropdownLabel } from './ui-state';
import { resolveLightIndexFromLabel } from './text-utils';

export interface DropdownView {
  firstVisible: number;
  labels: DropdownLabel[];
}

/**
 * Extract all text labels from the dropdown list area that match known light switches.
 * Returns raw matches including duplicates from multiple render cycles.
 */
export function extractDropdownLabels(commands: PaintCommand[]): DropdownLabel[] {
  const dropdown = uiCoordinates.lightSwitches.dropdownList;
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const listTop = dropdown.firstItemY;
  const listBottom = dropdown.firstItemY + (dropdown.itemHeight * dropdown.visibleItems);
  const listLeft = Math.max(0, dropdown.itemX - 260);
  const listRight = arrowX + 8;

  const labels = extractTextLabels(commands);
  const matched: DropdownLabel[] = [];

  for (const label of labels) {
    if (label.top < listTop || label.bottom > listBottom) continue;
    if (label.right < listLeft || label.left > listRight) continue;
    const index = resolveLightIndexFromLabel(label.text);
    if (index === null) continue;
    const centerY = Math.round((label.top + label.bottom) / 2);
    const row = Math.floor((centerY - dropdown.firstItemY) / dropdown.itemHeight);
    if (row < 0 || row >= dropdown.visibleItems) continue;
    matched.push({ text: label.text, index, row, top: label.top, bottom: label.bottom });
  }

  return matched;
}

/**
 * Resolve the current dropdown view from paint commands.
 * Uses majority voting on label positions to determine firstVisible.
 * Returns null if fewer than 2 labels agree on firstVisible.
 */
export function resolveDropdownView(commands: PaintCommand[]): DropdownView | null {
  const allLabels = extractDropdownLabels(commands);
  if (allLabels.length < 2) return null;

  const maxFirstVisible = Math.max(0, lightSwitchList.length - uiCoordinates.lightSwitches.dropdownList.visibleItems);

  // Each label implies firstVisible = index - row. Vote on the most common.
  const votes = new Map<number, number>();
  for (const label of allLabels) {
    const candidate = label.index - label.row;
    if (candidate < 0 || candidate > maxFirstVisible) continue;
    votes.set(candidate, (votes.get(candidate) ?? 0) + 1);
  }

  if (votes.size === 0) return null;

  let bestCandidate = -1;
  let bestCount = 0;
  for (const [candidate, count] of votes) {
    if (count > bestCount) {
      bestCandidate = candidate;
      bestCount = count;
    }
  }

  if (bestCount < 2) return null;

  // Keep only labels consistent with the winning firstVisible, last occurrence per row wins
  const byRow = new Map<number, DropdownLabel>();
  for (const label of allLabels) {
    if (label.index - label.row !== bestCandidate) continue;
    byRow.set(label.row, label);
  }

  const labels = [...byRow.values()].sort((a, b) => a.row - b.row);
  return { firstVisible: bestCandidate, labels };
}

/**
 * Check if the view is sufficient for clicking a target index.
 * Requires at least 3 consistent labels and the target to be at its expected row.
 */
export function isViewReadyForClick(view: DropdownView | null, targetIndex: number): boolean {
  if (!view || view.labels.length < 3) return false;
  const targetLabel = view.labels.find(l => l.index === targetIndex);
  if (!targetLabel) return false;
  return targetLabel.row === targetIndex - view.firstVisible;
}

/**
 * Check if firstVisible is within an expected range.
 */
export function isViewInRange(
  view: DropdownView | null,
  range: { min: number; max: number },
): view is DropdownView {
  if (!view) return false;
  return view.firstVisible >= range.min && view.firstVisible <= range.max;
}
