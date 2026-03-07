import { WebVisuProtocolClient } from '../protocol/client';
import { ProtocolDebugRenderer } from '../protocol/debug-renderer';
import { PaintCommand } from '../protocol/paint-commands';
import { UIState } from './ui-state';
import pino from 'pino';

export interface CommandContext {
  readonly client: WebVisuProtocolClient;
  readonly state: UIState;
  readonly debugRenderer: ProtocolDebugRenderer | null;
  readonly logger: pino.Logger;
  pollPaintCommands(reason: string): Promise<PaintCommand[]>;
  delay(ms: number): Promise<void>;
}
