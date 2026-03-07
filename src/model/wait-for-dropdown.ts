import { PaintCommand } from '../protocol/paint-commands';
import { CommandContext } from './command-context';
import { DropdownView, resolveDropdownView, extractDropdownLabels, isViewReadyForClick, isViewInRange } from './dropdown-labels';
import { isDropdownDefinitivelyClosed } from './dropdown-detection';

export class CommandWindow {
  private commands: PaintCommand[] = [];
  constructor(private readonly maxSize: number = 240) {}

  seed(commands: PaintCommand[]): void {
    if (commands.length <= this.maxSize) {
      this.commands = commands.slice();
    } else {
      this.commands = commands.slice(-this.maxSize);
    }
  }

  append(commands: PaintCommand[]): void {
    this.commands.push(...commands);
    if (this.commands.length > this.maxSize) {
      this.commands = this.commands.slice(-this.maxSize);
    }
  }

  getCommands(): PaintCommand[] {
    return this.commands;
  }
}

export interface WaitForDropdownOptions {
  seedCommands: PaintCommand[];
  reason: string;
  timeoutMs: number;
  /** View's firstVisible must be in this range */
  expectedRange?: { min: number; max: number };
  /** View must be ready for clicking this index (≥3 labels + target visible) */
  readyForClickIndex?: number;
  /** Latest poll must contain fresh dropdown labels */
  requireFreshLabels?: boolean;
}

const CLOSED_SIGNAL_STREAK = 2;

export async function waitForDropdownReady(
  ctx: CommandContext,
  options: WaitForDropdownOptions,
): Promise<{ view: DropdownView | null; commands: PaintCommand[]; closedDetected: boolean }> {
  const { reason, timeoutMs, expectedRange, readyForClickIndex, requireFreshLabels } = options;
  const window = new CommandWindow(240);
  window.seed(options.seedCommands);
  const additional: PaintCommand[] = [];

  const isReady = (v: DropdownView | null, hasFreshLabels: boolean): boolean => {
    if (!v) return false;
    if (expectedRange && !isViewInRange(v, expectedRange)) return false;
    if (readyForClickIndex !== undefined && !isViewReadyForClick(v, readyForClickIndex)) return false;
    if (requireFreshLabels && !hasFreshLabels) return false;
    return true;
  };

  let view = resolveDropdownView(window.getCommands());
  if (expectedRange && !isViewInRange(view, expectedRange)) view = null;

  if (isReady(view, false) && !requireFreshLabels) {
    return { view, commands: additional, closedDetected: false };
  }

  if (timeoutMs <= 0) {
    return { view: isReady(view, false) ? view : null, commands: additional, closedDetected: false };
  }

  let closedDetected = false;
  let closedStreak = 0;

  const deadline = Date.now() + timeoutMs;
  let poll = 0;

  while (Date.now() < deadline && !closedDetected) {
    poll++;
    const cmds = await ctx.pollPaintCommands(`dropdown-ready:${reason}:${poll}`);
    additional.push(...cmds);
    window.append(cmds);

    const closedSignal = isDropdownDefinitivelyClosed(cmds);
    closedStreak = closedSignal ? closedStreak + 1 : 0;
    closedDetected = closedStreak >= CLOSED_SIGNAL_STREAK;

    const candidate = resolveDropdownView(window.getCommands());
    const freshLabels = extractDropdownLabels(cmds).length > 0;

    if (isReady(candidate, freshLabels)) {
      view = candidate;
      break;
    }

    if (candidate && (!expectedRange || isViewInRange(candidate, expectedRange))) {
      view = candidate;
    }

    if (closedDetected) break;

    const remaining = deadline - Date.now();
    if (remaining > 0) await ctx.delay(Math.min(150, remaining));
  }

  return { view, commands: additional, closedDetected };
}
