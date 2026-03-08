import { PaintCommand } from '../protocol/paint-commands';
import { CommandContext } from '../model/command-context';
import {
  DropdownSelectionResult,
  extractDropdownHeaderLabel,
  isExpectedDropdownHeader,
} from '../model/header-verification';
import { uiCoordinates } from '../config';
import pino from 'pino';

const logger = pino({ name: 'select-dropdown-item' });

export async function selectDropdownItemAndCollect(
  ctx: CommandContext,
  lightId: string,
  expectedIndex: number,
  itemX: number,
  itemY: number,
): Promise<DropdownSelectionResult> {
  const selectCommands: PaintCommand[] = [];

  const isExpectedHeader = (header: string | null): boolean =>
    isExpectedDropdownHeader(expectedIndex, header);
  const downOnlyPollDeadline = Date.now() + 1200;
  const upFallbackPollDeadlineMs = 2400;
  const extraSettlePollDeadlineMs = 1800;
  const closeCommitPollDeadlineMs = 2400;

  const downCmds = await ctx.client.mouseDownAndCollect(itemX, itemY);
  selectCommands.push(...downCmds);
  ctx.window.append(downCmds);

  let headerLabel: string | null = extractDropdownHeaderLabel(selectCommands);
  let expectedHeaderSeen = isExpectedHeader(headerLabel);
  let headerPolls = 0;

  while (!expectedHeaderSeen && Date.now() < downOnlyPollDeadline) {
    headerPolls++;
    const cmds = await ctx.pollPaintCommands(`select-settle-down:${headerPolls}:${lightId}`);
    selectCommands.push(...cmds);
    headerLabel = extractDropdownHeaderLabel(selectCommands);
    expectedHeaderSeen = isExpectedHeader(headerLabel);
    if (expectedHeaderSeen) break;
    const remaining = downOnlyPollDeadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(150, remaining));
  }

  // Some PLC pages commit dropdown selection on mouseUp. Fall back to full click
  // only when mouseDown phase did not produce the expected header.
  if (!expectedHeaderSeen) {
    const upCmds = await ctx.client.mouseUpAndCollect(itemX, itemY);
    selectCommands.push(...upCmds);
    ctx.window.append(upCmds);

    const upDeadline = Date.now() + upFallbackPollDeadlineMs;
    while (!expectedHeaderSeen && Date.now() < upDeadline) {
      headerPolls++;
      const cmds = await ctx.pollPaintCommands(`select-settle-up:${headerPolls}:${lightId}`);
      selectCommands.push(...cmds);
      headerLabel = extractDropdownHeaderLabel(selectCommands);
      expectedHeaderSeen = isExpectedHeader(headerLabel);
      if (expectedHeaderSeen) break;
      const remaining = upDeadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(150, remaining));
    }
  }

  if (expectedHeaderSeen) {
    const extraCmds = await ctx.pollPaintCommands(`select-extra:${lightId}`);
    selectCommands.push(...extraCmds);
    return { commands: selectCommands, headerLabel };
  }

  // Some PLC pages publish the selected header asynchronously. Keep polling
  // for a short grace period before trying explicit close-to-commit.
  const extraDeadline = Date.now() + extraSettlePollDeadlineMs;
  while (!expectedHeaderSeen && Date.now() < extraDeadline) {
    headerPolls++;
    const cmds = await ctx.pollPaintCommands(`select-settle-extra:${headerPolls}:${lightId}`);
    selectCommands.push(...cmds);
    headerLabel = extractDropdownHeaderLabel(selectCommands);
    expectedHeaderSeen = isExpectedHeader(headerLabel);
    if (expectedHeaderSeen) break;
    const remaining = extraDeadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(150, remaining));
  }

  if (!expectedHeaderSeen) {
    // If still not committed, close the dropdown and continue polling.
    const arrow = uiCoordinates.lightSwitches.dropdownArrow;
    const closeCmds = await ctx.client.pressAndCollect(arrow.x, arrow.y);
    selectCommands.push(...closeCmds);
    ctx.window.append(closeCmds);

    const closeDeadline = Date.now() + closeCommitPollDeadlineMs;
    while (!expectedHeaderSeen && Date.now() < closeDeadline) {
      headerPolls++;
      const cmds = await ctx.pollPaintCommands(`select-settle-close:${headerPolls}:${lightId}`);
      selectCommands.push(...cmds);
      headerLabel = extractDropdownHeaderLabel(selectCommands);
      expectedHeaderSeen = isExpectedHeader(headerLabel);
      if (expectedHeaderSeen) break;
      const remaining = closeDeadline - Date.now();
      if (remaining > 0) await ctx.delay(Math.min(150, remaining));
    }
  }

  return { commands: selectCommands, headerLabel };
}
