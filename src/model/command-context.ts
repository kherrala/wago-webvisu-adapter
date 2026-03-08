import { WebVisuProtocolClient } from '../protocol/client';
import { ProtocolDebugRenderer } from '../renderer';
import { PaintCommand } from '../protocol/paint-commands';
import { UIState } from './ui-state';
import pino from 'pino';

export class CommandWindow {
  private commands: PaintCommand[] = [];
  constructor(private readonly maxSize: number = 2000) {}

  append(commands: PaintCommand[]): void {
    this.commands.push(...commands);
    if (this.commands.length > this.maxSize) {
      const trimCount = this.commands.length - this.maxSize;
      this.commands = this.commands.slice(trimCount);
    }
  }

  getCommands(): PaintCommand[] {
    return this.commands;
  }

  clear(): void {
    this.commands = [];
  }
}

export interface CommandContext {
  readonly client: WebVisuProtocolClient;
  readonly state: UIState;
  readonly debugRenderer: ProtocolDebugRenderer | null;
  readonly logger: pino.Logger;
  readonly window: CommandWindow;
  pollPaintCommands(reason: string): Promise<PaintCommand[]>;
  delay(ms: number): Promise<void>;
}
