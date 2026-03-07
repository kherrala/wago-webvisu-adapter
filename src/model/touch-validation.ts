import { uiCoordinates } from '../config';
import { PaintCommand, extractLatestTouchRectangles, TouchRectangleCommand } from '../protocol/paint-commands';

export function resolveDropdownRowTouchRectangles(commands: PaintCommand[]): Array<{ row: number; rect: TouchRectangleCommand }> {
  const dropdown = uiCoordinates.lightSwitches.dropdownList;
  const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
  const listTop = dropdown.firstItemY;
  const listBottom = dropdown.firstItemY + (dropdown.itemHeight * dropdown.visibleItems) - 1;
  const listLeft = Math.max(0, dropdown.itemX - 260);
  const listRight = arrowX + 8;

  const latestTouchRects = extractLatestTouchRectangles(commands);
  if (latestTouchRects.length === 0) return [];

  return latestTouchRects
    .map((rect) => {
      const width = Math.max(1, rect.right - rect.left + 1);
      const height = Math.max(1, rect.bottom - rect.top + 1);
      const centerY = Math.round((rect.top + rect.bottom) / 2);
      const row = Math.floor((centerY - dropdown.firstItemY) / dropdown.itemHeight);
      return { rect, width, height, row };
    })
    .filter((item) => item.row >= 0 && item.row < dropdown.visibleItems)
    .filter((item) => item.rect.left <= listRight && item.rect.right >= listLeft)
    .filter((item) => item.rect.top <= listBottom && item.rect.bottom >= listTop)
    .filter((item) => item.width >= 160)
    .filter((item) => item.height >= (dropdown.itemHeight - 12) && item.height <= (dropdown.itemHeight + 20))
    .map((item) => ({ row: item.row, rect: item.rect }));
}

export function resolveTouchValidatedDropdownClickY(
  commands: PaintCommand[],
  targetRow: number,
  clickX: number,
  fallbackY: number,
): {
  y: number;
  source: 'touch-rect-validated' | 'touch-rect-adjusted' | 'no-touch-rect';
  usedTouchRectangles: boolean;
  targetRowRectCount: number;
  totalRowRectCount: number;
} {
  const rowTouchRects = resolveDropdownRowTouchRectangles(commands);
  if (rowTouchRects.length === 0) {
    return {
      y: fallbackY,
      source: 'no-touch-rect',
      usedTouchRectangles: false,
      targetRowRectCount: 0,
      totalRowRectCount: 0,
    };
  }

  const targetRects = rowTouchRects
    .filter((entry) => entry.row === targetRow)
    .filter((entry) => clickX >= entry.rect.left && clickX <= entry.rect.right);
  if (targetRects.length === 0) {
    throw new Error(`Touch-rect validation failed: no hittable row for targetRow=${targetRow}, x=${clickX}`);
  }

  const bestRect = targetRects
    .map((entry) => ({
      rect: entry.rect,
      centerDistance: Math.abs(Math.round((entry.rect.top + entry.rect.bottom) / 2) - fallbackY),
    }))
    .sort((a, b) => a.centerDistance - b.centerDistance)[0].rect;

  if (fallbackY >= bestRect.top && fallbackY <= bestRect.bottom) {
    return {
      y: fallbackY,
      source: 'touch-rect-validated',
      usedTouchRectangles: true,
      targetRowRectCount: targetRects.length,
      totalRowRectCount: rowTouchRects.length,
    };
  }

  const innerTop = bestRect.top + 1;
  const innerBottom = bestRect.bottom - 1;
  const adjustedY = innerTop <= innerBottom
    ? Math.max(innerTop, Math.min(innerBottom, fallbackY))
    : Math.round((bestRect.top + bestRect.bottom) / 2);
  return {
    y: adjustedY,
    source: 'touch-rect-adjusted',
    usedTouchRectangles: true,
    targetRowRectCount: targetRects.length,
    totalRowRectCount: rowTouchRects.length,
  };
}
