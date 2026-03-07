import { config, uiCoordinates, lightSwitchList } from '../config';
import { PaintCommand } from '../protocol/paint-commands';
import { CommandContext } from '../model/command-context';
import { PaintCollector } from '../model/paint-collector';
import { DropdownView, isViewReadyForClick } from '../model/dropdown-labels';
import { DropdownSelectionResult, extractDropdownHeaderLabel } from '../model/header-verification';
import { resolveTouchValidatedDropdownClickY } from '../model/touch-validation';
import { resolveLightIndexFromLabel } from '../model/text-utils';
import { waitForDropdownReady } from '../model/wait-for-dropdown';
import { reopenDropdownFromClosed } from './ensure-dropdown-closed';
import { resolveIndicatorImages, resolveLampStatus } from './resolve-light-status';
import pino from 'pino';

const logger = pino({ name: 'select-dropdown-item' });

export async function selectDropdownItemAndCollect(
  ctx: CommandContext,
  lightId: string,
  itemX: number,
  itemY: number,
  strategy: DropdownSelectionResult['strategy'],
): Promise<DropdownSelectionResult> {
  const selectCommands: PaintCommand[] = [];
  const selectionSettleMs = Math.max(0, config.protocol?.selectionSettleDelayMs ?? 200);

  const pressCmds = await ctx.client.mouseDownAndCollect(itemX, itemY);
  selectCommands.push(...pressCmds);

  if (strategy === 'press-primary') {
    if (selectionSettleMs > 0) await ctx.delay(selectionSettleMs);
  } else {
    const fallbackSettleMs = Math.max(250, selectionSettleMs + 150);
    if (fallbackSettleMs > 0) await ctx.delay(fallbackSettleMs);
  }

  const pollPrefix = strategy === 'press-primary' ? 'select-settle' : 'select-fallback-settle';
  const extraPrefix = strategy === 'press-primary' ? 'select-extra' : 'select-fallback-extra';
  const headerPollTimeoutMs = strategy === 'press-primary' ? 3000 : 3500;
  const headerPollDeadline = Date.now() + headerPollTimeoutMs;
  let headerLabel: string | null = extractDropdownHeaderLabel(selectCommands);
  let headerPolls = 0;

  while (headerLabel === null && Date.now() < headerPollDeadline) {
    headerPolls++;
    const cmds = await ctx.pollPaintCommands(`${pollPrefix}:${headerPolls}:${lightId}`);
    selectCommands.push(...cmds);
    headerLabel = extractDropdownHeaderLabel(selectCommands);
    if (headerLabel !== null) break;
    const remaining = headerPollDeadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(150, remaining));
  }

  if (headerLabel !== null) {
    const extraCmds = await ctx.pollPaintCommands(`${extraPrefix}:${lightId}`);
    selectCommands.push(...extraCmds);
  }

  return { commands: selectCommands, headerLabel, strategy };
}

export async function tryFallbackDropdownSelection(
  ctx: CommandContext,
  collector: PaintCollector,
  lightId: string,
  index: number,
  rowClickX: number,
): Promise<{ selection: DropdownSelectionResult } | null> {
  const dropdownConfig = uiCoordinates.lightSwitches.dropdownList;
  logger.warn({ lightId, index }, 'Primary selection mismatch; attempting fallback press gesture');

  const reopenCollector = new PaintCollector();
  const { view } = await reopenDropdownFromClosed(ctx, reopenCollector, `select-fallback:${lightId}`);
  collector.add(reopenCollector.getAll());

  let resolvedView: DropdownView | null = view;
  if (!isViewReadyForClick(resolvedView, index)) {
    const settled = await waitForDropdownReady(ctx, {
      seedCommands: reopenCollector.getAll(),
      reason: `select-fallback:${lightId}`,
      timeoutMs: 2500,
      readyForClickIndex: index,
      requireFreshLabels: true,
    });
    collector.add(settled.commands);
    if (settled.closedDetected) {
      logger.warn({ lightId, index }, 'Fallback selection aborted: dropdown closed while waiting for ready view');
      return null;
    }
    resolvedView = settled.view;
  }

  if (!resolvedView) {
    logger.warn({ lightId, index }, 'Fallback selection aborted: no reliable dropdown view');
    return null;
  }

  ctx.state.applyDropdownView(resolvedView);
  const positionInView = index - resolvedView.firstVisible;
  if (positionInView < 0 || positionInView >= dropdownConfig.visibleItems) {
    logger.warn({ lightId, index, firstVisible: resolvedView.firstVisible }, 'Fallback selection aborted: target row not visible');
    return null;
  }

  const fallbackY = dropdownConfig.firstItemY +
    (positionInView * dropdownConfig.itemHeight) +
    Math.round(dropdownConfig.itemHeight / 2);
  const touchValidatedTarget = resolveTouchValidatedDropdownClickY(
    reopenCollector.getAll(),
    positionInView,
    rowClickX,
    fallbackY,
  );
  const selection = await selectDropdownItemAndCollect(
    ctx,
    lightId,
    rowClickX,
    touchValidatedTarget.y,
    'press-fallback',
  );

  return { selection };
}

export function opportunisticallyCacheStatus(
  commands: PaintCommand[],
  actualHeaderLabel: string,
  state: { lastStatusByLight: Map<string, boolean> },
): void {
  const actualIndex = resolveLightIndexFromLabel(actualHeaderLabel);
  if (actualIndex === null) {
    logger.warn({ actualHeaderLabel }, 'Opportunistic cache: could not resolve switch index from header label');
    return;
  }

  const sw = lightSwitchList.find(s => s.index === actualIndex);
  if (!sw) {
    logger.warn({ actualIndex, actualHeaderLabel }, 'Opportunistic cache: switch not found in list');
    return;
  }

  const indicatorImages = resolveIndicatorImages(commands);
  const firstPressLightId = (sw as any).firstPressLightId as string | undefined;
  const secondPressLightId = (sw as any).secondPressLightId as string | undefined;

  const key1 = firstPressLightId ?? `${sw.id}:1`;
  const isOn1 = resolveLampStatus(indicatorImages.indicator1);
  if (isOn1 !== null) state.lastStatusByLight.set(key1, isOn1);

  const key2 = secondPressLightId ?? `${sw.id}:2`;
  const isOn2 = secondPressLightId ? resolveLampStatus(indicatorImages.indicator2) : null;
  if (isOn2 !== null) state.lastStatusByLight.set(key2, isOn2);

  logger.info({
    switchId: sw.id,
    actualHeaderLabel,
    indicator1: { key: key1, isOn: isOn1 },
    ...(secondPressLightId ? { indicator2: { key: key2, isOn: isOn2 } } : {}),
  }, 'Opportunistically cached status for accidentally-selected switch');
}
