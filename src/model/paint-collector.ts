import { PaintCommand } from '../protocol/paint-commands';

export class PaintCollector {
  private commands: PaintCommand[] = [];

  add(commands: PaintCommand[]): void {
    this.commands.push(...commands);
  }

  getAll(): PaintCommand[] {
    return this.commands;
  }

  recent(maxCount = 240): PaintCommand[] {
    if (this.commands.length <= maxCount) return this.commands;
    return this.commands.slice(-maxCount);
  }

  get length(): number {
    return this.commands.length;
  }
}
