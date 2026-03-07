// Simplified protocol controller for CoDeSys WebVisu.
// Strategy:
// - Poll for current paint state via viewport event after each UI step.
// - Use only explicit lamp image IDs for status detection.
// - Reconnect automatically when consecutive empty renders exceed threshold.

import {
  config,
  uiCoordinates,
  lightSwitches,
  lightSwitchNames,
  lightSwitchPlcLabels,
  lightSwitchById,
  lightSwitchList,
} from './config';
import { IWebVisuController, LightStatus } from './controller-interface';
import { WebVisuProtocolClient } from './protocol/client';
import { buildViewportEvent } from './protocol/messages';
import {
  PaintCommand,
  ImageDrawCommand,
  TouchRectangleCommand,
  extractDrawImages,
  extractLatestTouchRectangles,
  extractTextLabels,
} from './protocol/paint-commands';
import { ProtocolDebugRenderer } from './protocol/debug-renderer';
import pino from 'pino';

const logger = pino({ name: 'protocol-controller' });

const LAMP_IMAGE_OFF = '__visualizationstyle.element-lamp-lamp1-yellow-off';
const LAMP_IMAGE_ON = '__visualizationstyle.element-lamp-lamp1-yellow-on';

type DropdownSnapshot = {
  firstVisible: number;
  handleCenterY: number;
  labels: Array<{ text: string; index: number; top: number; bottom: number; row: number }>;
};

type DropdownSelectionResult = {
  commands: PaintCommand[];
  headerLabel: string | null;
  strategy: 'press-primary' | 'press-fallback';
};

type DropdownSnapshotBounds = {
  minFirstVisible: number;
  maxFirstVisible: number;
};

class DropdownHeaderMismatchError extends Error {
  readonly lightId: string;
  readonly index: number;
  readonly expectedPlcLabel: string;
  readonly expectedName: string;
  readonly actualHeaderLabel: string | null;
  readonly mismatchKind: 'missing' | 'mismatch';

  constructor(params: {
    lightId: string;
    index: number;
    expectedPlcLabel: string;
    expectedName: string;
    actualHeaderLabel: string | null;
    mismatchKind: 'missing' | 'mismatch';
  }) {
    const { lightId, index, expectedPlcLabel, expectedName, actualHeaderLabel, mismatchKind } = params;
    const message = mismatchKind === 'missing'
      ? `Header verification failed: header text missing for light=${lightId}, index=${index}, expected="${expectedPlcLabel}" or "${expectedName}"`
      : `Header verification failed: expected="${expectedPlcLabel}" or "${expectedName}", got="${actualHeaderLabel}", light=${lightId}, index=${index}`;
    super(message);
    this.name = 'DropdownHeaderMismatchError';
    this.lightId = lightId;
    this.index = index;
    this.expectedPlcLabel = expectedPlcLabel;
    this.expectedName = expectedName;
    this.actualHeaderLabel = actualHeaderLabel;
    this.mismatchKind = mismatchKind;
  }
}

export class ProtocolController implements IWebVisuController {
  private static readonly MIN_INITIAL_RENDER_TIMEOUT_MS = 3500;
  private static readonly DEFAULT_INITIAL_RENDER_TIMEOUT_MS = 7000;
  private static readonly MIN_INITIAL_RENDER_POLL_INTERVAL_MS = 50;
  private static readonly DEFAULT_INITIAL_RENDER_POLL_INTERVAL_MS = 200;
  private static readonly RECONNECT_EMPTY_THRESHOLD = 10;
  private static readonly RECONNECT_COOLDOWN_MS = 30_000;
  private static readonly DROPDOWN_SNAPSHOT_WINDOW_COMMANDS = 240;
  private static readonly DROPDOWN_CLOSED_SIGNAL_STREAK = 2;

  private client: WebVisuProtocolClient;
  private debugRenderer: ProtocolDebugRenderer | null = null;
  private initialized = false;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;

  // Dropdown scroll tracking.
  private dropdownFirstVisible = 0;
  private dropdownHandleCenterY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;

  // Cache status by physical light name (normalised firstPress/secondPress text).
  // Keyed this way so that multiple switches controlling the same light share one entry.
  private lastStatusByLight = new Map<string, boolean>();

  // Reconnection state.
  private consecutiveEmptyRenders = 0;
  private lastReconnectAt = 0;

  constructor() {
    const protocolHost = config.protocol?.host ?? '192.168.1.10';
    const protocolPort = config.protocol?.port ?? 443;
    const debugRenderEnabled = config.protocol?.debugRenderEnabled ?? false;
    this.debugRenderer = this.createDebugRenderer(protocolHost, protocolPort, debugRenderEnabled);

    this.client = new WebVisuProtocolClient({
      host: protocolHost,
      port: protocolPort,
      requestTimeout: config.protocol?.requestTimeout ?? 5000,
      reconnectDelay: config.protocol?.reconnectDelay ?? 5000,
      postClickDelay: config.protocol?.postClickDelay ?? 50,
      postSelectDelay: config.protocol?.postSelectDelay ?? 100,
      debugHttp: config.protocol?.debugHttp ?? false,
      sessionTraceEnabled: config.protocol?.sessionTraceEnabled ?? true,
      sessionTraceDir: config.protocol?.sessionTraceDir ?? '/data/protocol-trace',
      logRawFrameData: config.protocol?.logRawFrameData ?? false,
      postDataInHeader: config.protocol?.postDataInHeader ?? 'auto',
      deviceUsername: config.protocol?.deviceUsername ?? '',
      devicePassword: config.protocol?.devicePassword ?? '',
      // Always feed paint frames into the renderer so the surface state stays current.
      onPaintFrame: (frame) => {
        this.debugRenderer?.record(frame);
      },
    });
  }

  private createDebugRenderer(protocolHost: string, protocolPort: number, debugRenderEnabled: boolean): ProtocolDebugRenderer | null {
    try {
      return new ProtocolDebugRenderer({
        // noDisk=true when debug render is not explicitly enabled — the renderer still
        // accumulates paint state in memory so getRenderedUiImage() always works.
        noDisk: !debugRenderEnabled,
        outputDir: config.protocol?.debugRenderDir ?? '/data/protocol-render-debug',
        width: config.browser.viewport.width,
        height: config.browser.viewport.height,
        maxFrames: config.protocol?.debugRenderMaxFrames ?? 400,
        minIntervalMs: config.protocol?.debugRenderMinIntervalMs ?? 0,
        includeEmptyFrames: config.protocol?.debugRenderIncludeEmptyFrames ?? true,
        ...(debugRenderEnabled
          ? {
            imageSource: {
              enabled: config.protocol?.debugRenderFetchImages ?? true,
              host: protocolHost,
              port: protocolPort,
              rejectUnauthorized: false,
              referer: `https://${protocolHost}/webvisu/webvisu.htm`,
              basePath: '/webvisu',
              timeoutMs: config.protocol?.debugRenderImageFetchTimeoutMs ?? 1200,
            },
          }
          : {}),
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize protocol debug renderer; rendered-ui endpoint will return empty');
      return null;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.info('Already initialized');
      return;
    }

    logger.info('Initializing protocol controller...');
    if (!this.debugRenderer) {
      const protocolHost = config.protocol?.host ?? '192.168.1.10';
      const protocolPort = config.protocol?.port ?? 443;
      const debugRenderEnabled = config.protocol?.debugRenderEnabled ?? false;
      this.debugRenderer = this.createDebugRenderer(protocolHost, protocolPort, debugRenderEnabled);
    }
    await this.client.connect();

    // Wait until initial screen has visible paint data before any tab click.
    await this.waitForInitialRenderReady();

    logger.info('Navigating to Napit tab...');
    await this.navigateToNapitTab();

    this.initialized = true;
    logger.info('Protocol controller initialized successfully');
  }

  async close(): Promise<void> {
    await this.client.disconnect();
    if (this.debugRenderer) {
      try {
        await this.debugRenderer.close();
      } catch (error) {
        logger.warn({ error }, 'Failed to close protocol debug renderer cleanly');
      }
      this.debugRenderer = null;
    }
    this.initialized = false;
    this.dropdownFirstVisible = 0;
    this.dropdownHandleCenterY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;


    this.lastStatusByLight.clear();
    this.consecutiveEmptyRenders = 0;
    logger.info('Protocol controller closed');
  }

  resetDropdownState(): void {
    this.dropdownFirstVisible = 0;
    this.dropdownHandleCenterY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;


    logger.info('Dropdown state reset to top');
  }

  getPendingOperationCount(): number {
    return this.pendingOperations;
  }

  async navigateToTab(tabName: string): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      await this.doNavigateToTab(tabName);
    });
  }

  private async doNavigateToTab(tabName: string): Promise<void> {
    const coords = (uiCoordinates.tabs as Record<string, { x: number; y: number }>)[tabName];
    if (!coords) {
      throw new Error(`Unknown tab: ${tabName}`);
    }

    if (tabName === 'napit') {
      await this.navigateToNapitTab();
      return;
    }

    logger.info(`Navigating to tab: ${tabName} at (${coords.x}, ${coords.y})`);
    await this.client.clickAndCollect(coords.x, coords.y);
    await this.pollPaintCommands(`navigate:${tabName}`);
  }

  async selectLightSwitch(lightId: string): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      await this.doSelectLightSwitch(lightId);
    });
  }

  private async doSelectLightSwitch(lightId: string): Promise<{ allCommands: PaintCommand[]; postSelectionCommands: PaintCommand[] }> {
    const index = lightSwitches[lightId];
    if (index === undefined) {
      throw new Error(`Unknown light switch: ${lightId}. Valid IDs: ${Object.keys(lightSwitches).join(', ')}`);
    }

    const maxAttempts = config.protocol?.maxSelectionAttempts ?? 5;
    let lastError: Error | null = null;
    let previousMismatchKey: string | null = null;
    let mismatchStreak = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.doSelectLightSwitchOnce(lightId, index);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        let triggeredReconnect = false;
        if (lastError instanceof DropdownHeaderMismatchError) {
          const currentMismatchKey = lastError.actualHeaderLabel
            ? this.normalizeVisuText(lastError.actualHeaderLabel)
            : '__missing-header__';
          if (currentMismatchKey === previousMismatchKey) {
            mismatchStreak++;
          } else {
            previousMismatchKey = currentMismatchKey;
            mismatchStreak = 1;
          }

          if (mismatchStreak >= 2 && attempt < maxAttempts) {
            await this.forceDropdownResync(`header-mismatch-streak:${lightId}:${attempt}`);
          }
          if (mismatchStreak >= 3 && attempt < maxAttempts) {
            await this.doReconnect(`selection-repeated-header-mismatch:${lightId}`);
            triggeredReconnect = true;
            mismatchStreak = 0;
            previousMismatchKey = null;
          }
        } else {
          mismatchStreak = 0;
          previousMismatchKey = null;
        }

        logger.warn({ err: lastError, lightId, attempt, maxAttempts, triggeredReconnect }, 'Selection attempt failed, retrying');
        // Reset dropdown state so the next attempt discovers the scroll
        // position from paint data rather than using stale tracked state.
        this.resetDropdownState();
      }
    }

    throw lastError!;
  }

  private async doSelectLightSwitchOnce(lightId: string, index: number): Promise<{ allCommands: PaintCommand[]; postSelectionCommands: PaintCommand[] }> {
    logger.info(`Selecting light switch: ${lightId} (index: ${index})`);
    await this.ensureDropdownClosed(`select-start:${lightId}`);

    // Step 1: Open dropdown with verification.
    // The dropdown opens on mouseDown. pressAndCollect captures mouseDown + mouseUp responses.
    // Assumption: dropdown is closed at operation start (operations are serialized).
    const allDropdownCommands: PaintCommand[] = [];

    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;

    const dropdownConfig = uiCoordinates.lightSwitches.dropdownList;
    const scrollbarConfig = uiCoordinates.lightSwitches.scrollbar;
    const maxFirstVisible = this.getDropdownMaxFirstVisible();

    const dropdownOpenTimeoutMs = config.protocol?.dropdownOpenTimeoutMs ?? 6000;
    const maxOpenAttempts = 3;
    let dropdownOpened = false;
    // Commands accumulated within the current open attempt. Used for
    // isDropdownOpen (which needs accumulated data since the dropdown content
    // arrives across multiple render cycles) and for snapshot/sync (safe
    // because all commands within one attempt share the same scroll state).
    let attemptCommands: PaintCommand[] = [];

    for (let openAttempt = 1; openAttempt <= maxOpenAttempts; openAttempt++) {
      attemptCommands = [];
      const { downCommands, upCommands } = await this.client.pressAndCollectDetailed(arrowX, arrowY);
      const clickCommands = [...downCommands, ...upCommands];
      attemptCommands.push(...clickCommands);
      allDropdownCommands.push(...clickCommands);
      logger.info({
        openAttempt,
        commandCount: clickCommands.length,
        labelCount: extractTextLabels(clickCommands).length,
      }, 'Dropdown open: pressAndCollect response');

      const settledCommands: PaintCommand[] = [...upCommands];
      if (this.didPressLeaveDropdownOpen(downCommands, settledCommands)) {
        dropdownOpened = true;
        attemptCommands = [...downCommands, ...settledCommands];
        break;
      }

      // Poll with heartbeat until dropdown content arrives or timeout.
      // The dropdown takes multiple render cycles to open fully — accumulate
      // all commands and check the running total against isDropdownOpen.
      const deadline = Date.now() + dropdownOpenTimeoutMs;
      let poll = 0;
      while (Date.now() < deadline) {
        poll++;
        const cmds = await this.pollPaintCommands(`dropdown-open-verify:${openAttempt}:${poll}:${lightId}`);
        settledCommands.push(...cmds);
        attemptCommands.push(...cmds);
        allDropdownCommands.push(...cmds);
        if (this.didPressLeaveDropdownOpen(downCommands, settledCommands)) {
          dropdownOpened = true;
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await this.delay(Math.min(200, remaining));
        }
      }

      if (dropdownOpened) break;

      // Dropdown didn't open — click arrow again to close (in case it partially opened), then retry.
      if (openAttempt < maxOpenAttempts) {
        logger.warn({ lightId, openAttempt }, 'Dropdown not verified as open after final-state checks; resetting and retrying');
        await this.ensureDropdownClosed(`open-retry:${lightId}:${openAttempt}`);
      }
    }

    if (!dropdownOpened) {
      throw new Error(`Dropdown failed to open after ${maxOpenAttempts} attempts for light=${lightId}`);
    }

    const openSettle = await this.waitForDropdownSnapshot(
      attemptCommands,
      `open-settle:${lightId}`,
      1600,
    );
    if (openSettle.commands.length > 0) {
      attemptCommands.push(...openSettle.commands);
      allDropdownCommands.push(...openSettle.commands);
    }
    if (openSettle.closedDetected && !openSettle.snapshot) {
      throw new Error(`Dropdown closed during open settle for light=${lightId}`);
    }

    // Step 2: Dropdown is open — sync scroll state from this attempt's commands.
    // All commands within one attempt share the same scroll position, so
    // accumulated data is safe for resolving the snapshot.
    this.syncDropdownStateFromCommands(attemptCommands, 'on-open');
    let latestSnapshot = this.resolveDropdownSnapshot(attemptCommands);
    let latestSnapshotCommands: PaintCommand[] = [...attemptCommands];
    logger.info({
      hasSnapshot: !!latestSnapshot,
      firstVisible: latestSnapshot?.firstVisible,
      labelCount: latestSnapshot?.labels.length,
      labels: latestSnapshot?.labels.map(l => ({ text: l.text, index: l.index, row: l.row, top: l.top })),
    }, 'Initial dropdown snapshot');

    const stepCommands: PaintCommand[] = [...allDropdownCommands];

    // Step 3: Scroll to bring the target into view.
    const targetFirstVisible = this.getTargetFirstVisible(index, maxFirstVisible);
    const scrollbarX = scrollbarConfig.x;

    // 3b: Scroll loop — arrow clicks for small deltas, drag for large ones.
    const ARROW_THRESHOLD = 5;
    const dragStartHoldMs = config.protocol?.dragStartHoldMs ?? 60;
    const dragStepDelayMs = Math.max(0, config.protocol?.dragStepDelayMs ?? 45);
    const dragEndHoldMs = Math.max(0, config.protocol?.dragEndHoldMs ?? 50);
    const maxScrollAttempts = 6;

    for (let scrollAttempt = 0; scrollAttempt < maxScrollAttempts && !this.isDropdownIndexVisible(index); scrollAttempt++) {
      const delta = targetFirstVisible - this.dropdownFirstVisible;
      const absDelta = Math.abs(delta);
      const scrollStartFirstVisible = this.dropdownFirstVisible;

      const canUseArrowPath = absDelta <= ARROW_THRESHOLD && delta !== 0;
      if (canUseArrowPath) {
        // Arrow-click path for both short forward and backward moves.
        // Up-arrow Y was calibrated lower (config.ts) to stay inside the
        // button hitbox instead of clipping the header/list boundary.
        const scrollDirection: 'down' | 'up' = delta > 0 ? 'down' : 'up';
        const arrowBtn = scrollDirection === 'down'
          ? scrollbarConfig.arrowDown
          : scrollbarConfig.arrowUp;
        const arrowAllCmds: PaintCommand[] = [];

        logger.info({
          lightId, index, scrollAttempt, delta, absDelta,
          direction: scrollDirection,
          arrowX: arrowBtn.x, arrowY: arrowBtn.y,
        }, 'Arrow-click scroll');

        for (let i = 0; i < absDelta; i++) {
          const clickCmds = await this.client.pressAndCollect(arrowBtn.x, arrowBtn.y);
          arrowAllCmds.push(...clickCmds);
          stepCommands.push(...clickCmds);
          const settleCmds = await this.pollPaintCommands(`arrow-step:${scrollAttempt}:${i}`);
          arrowAllCmds.push(...settleCmds);
          stepCommands.push(...settleCmds);
          if (i < absDelta - 1) await this.delay(120);
        }

        // Poll for any remaining paint updates after the last arrow click.
        await this.delay(120);
        const arrowPollCmds = await this.pollPaintCommands(`arrow-scroll:${scrollAttempt}`);
        arrowAllCmds.push(...arrowPollCmds);
        stepCommands.push(...arrowPollCmds);

        const arrowBounds: DropdownSnapshotBounds = {
          minFirstVisible: Math.min(scrollStartFirstVisible, scrollStartFirstVisible + delta),
          maxFirstVisible: Math.max(scrollStartFirstVisible, scrollStartFirstVisible + delta),
        };

        // Sync state from the arrow-click responses.
        let snapshot = this.resolveDropdownSnapshot(this.getDropdownSnapshotWindow(arrowAllCmds));
        if (!this.isSnapshotWithinBounds(snapshot, arrowBounds)) {
          snapshot = null;
        }
        let snapshotSourceCommands: PaintCommand[] = this.getDropdownSnapshotWindow(arrowAllCmds);
        if (!snapshot) {
          const settled = await this.waitForDropdownSnapshot(
            arrowAllCmds,
            `arrow-scroll:${scrollAttempt}`,
            2000,
            arrowBounds,
          );
          arrowAllCmds.push(...settled.commands);
          stepCommands.push(...settled.commands);
          snapshot = settled.snapshot;
          let closedDetected = settled.closedDetected;
          snapshotSourceCommands = this.getDropdownSnapshotWindow(arrowAllCmds);

          if (!snapshot && closedDetected) {
            logger.warn({ scrollAttempt, lightId, delta }, 'Dropdown closed during arrow scroll (Ohjaus detected); reopening');
            const { snapshot: reopenSnapshot, commands: reopenCmds } = await this.reopenDropdownFromClosed(`arrow-scroll-reopen:${scrollAttempt}`);
            stepCommands.push(...reopenCmds);
            snapshot = reopenSnapshot;
            if (!this.isSnapshotWithinBounds(snapshot, arrowBounds)) {
              snapshot = null;
            }
            snapshotSourceCommands = this.getDropdownSnapshotWindow(reopenCmds);
            if (!snapshot) {
              const reopenSettled = await this.waitForDropdownSnapshot(
                reopenCmds,
                `arrow-scroll-reopen:${scrollAttempt}`,
                2000,
                arrowBounds,
              );
              stepCommands.push(...reopenSettled.commands);
              snapshot = reopenSettled.snapshot;
              snapshotSourceCommands = this.getDropdownSnapshotWindow([...reopenCmds, ...reopenSettled.commands]);
            }
          }
        }

        let arrowProgressed = false;
        if (snapshot) {
          this.dropdownFirstVisible = snapshot.firstVisible;
          this.dropdownHandleCenterY = snapshot.handleCenterY;
          latestSnapshot = snapshot;
          latestSnapshotCommands = snapshotSourceCommands;
          arrowProgressed = snapshot.firstVisible !== scrollStartFirstVisible;
          logger.info({ scrollAttempt, firstVisible: snapshot.firstVisible }, 'Arrow-scroll snapshot synced');
        }
        if (snapshot && arrowProgressed) {
          // Arrow scrolling can leave label rendering and click hitboxes out
          // of sync. Force a close/reopen resync before continuing.
          await this.delay(120);
          const closeCmds = await this.client.pressAndCollect(arrowX, arrowY);
          stepCommands.push(...closeCmds);
          await this.delay(220);

          const { snapshot: reopenSnapshot, commands: reopenCmds } = await this.reopenDropdownFromClosed(`arrow-resync:${scrollAttempt}`);
          stepCommands.push(...reopenCmds);
          let syncedSnapshot = reopenSnapshot;
          let syncedSourceCommands: PaintCommand[] = [...reopenCmds];
          if (!syncedSnapshot) {
            const settled = await this.waitForDropdownSnapshot(
              reopenCmds,
              `arrow-resync:${scrollAttempt}`,
              2200,
            );
            stepCommands.push(...settled.commands);
            syncedSnapshot = settled.snapshot;
            syncedSourceCommands = [...reopenCmds, ...settled.commands];
          }

          if (!syncedSnapshot) {
            throw new Error(`Arrow resync produced no stable snapshot: light=${lightId}, index=${index}, target=${targetFirstVisible}, scrollAttempt=${scrollAttempt}`);
          }

          this.dropdownFirstVisible = syncedSnapshot.firstVisible;
          this.dropdownHandleCenterY = syncedSnapshot.handleCenterY;
          latestSnapshot = syncedSnapshot;
          latestSnapshotCommands = syncedSourceCommands;
          continue;  // Re-check visibility at top of loop
        }
        if (snapshot && !arrowProgressed) {
          logger.warn({ scrollAttempt, lightId, index, firstVisible: snapshot.firstVisible }, 'Arrow scroll produced no progress; falling back to drag');
        } else {
          logger.warn({ scrollAttempt, lightId, index, targetFirstVisible }, 'Arrow scroll did not produce stable snapshot; falling back to drag');
        }
      }

      // Drag path for large deltas (both forward and backward).
      // Uses a drag → mouseUp → close/reopen loop. Re-dragging from the actual
      // position converges quickly (each retry has a shorter distance).
      const currentHandleY = Math.round(this.dropdownHandleCenterY);
      const targetHandleY = Math.round(this.getDropdownScrollY(targetFirstVisible));

      logger.info({
        lightId, index, scrollAttempt,
        currentFirstVisible: this.dropdownFirstVisible, targetFirstVisible,
        delta, currentHandleY, targetHandleY,
      }, 'Dragging scrollbar thumb');

      await this.client.mouseDown(scrollbarX, currentHandleY);
      await this.delay(dragStartHoldMs);

      const dragDistance = Math.abs(targetHandleY - currentHandleY);
      const dragSteps = Math.max(2, Math.min(12, Math.ceil(dragDistance / 12)));
      let lastDragY = currentHandleY;
      for (let step = 1; step <= dragSteps; step++) {
        const interpolation = step / dragSteps;
        const moveY = Math.round(currentHandleY + ((targetHandleY - currentHandleY) * interpolation));
        if (moveY === lastDragY) {
          continue;
        }
        const moveCmds = await this.client.mouseMoveAndCollect(scrollbarX, moveY);
        stepCommands.push(...moveCmds);
        lastDragY = moveY;
        if (dragStepDelayMs > 0 && step < dragSteps) {
          await this.delay(dragStepDelayMs);
        }
      }

      // Let the PLC fully settle the final move before releasing.
      await this.delay(dragEndHoldMs);

      // Release the scrollbar handle.
      const dragUpCmds = await this.client.mouseUpAndCollect(scrollbarX, targetHandleY);
      stepCommands.push(...dragUpCmds);
      const dragSettleCmds = await this.pollPaintCommands(`drag-settle:${scrollAttempt}`);
      stepCommands.push(...dragSettleCmds);

      // After scrollbar drag + mouseUp, the PLC's rendered labels and click
      // targets can be out of sync. Close and reopen the dropdown to force
      // a full resync of both layers.
      await this.delay(200);

      // Close: click the dropdown arrow.
      const closeCmds = await this.client.pressAndCollect(arrowX, arrowY);
      stepCommands.push(...closeCmds);
      await this.delay(300);

      // Reopen the dropdown and sync scroll state.
      const { snapshot: reopenSnapshot, commands: reopenCmds } = await this.reopenDropdownFromClosed(`drag-reopen:${scrollAttempt}`);
      stepCommands.push(...reopenCmds);
      let snapshotAfterReopen = reopenSnapshot;
      let snapshotSourceCommands: PaintCommand[] = [...reopenCmds];
      if (!snapshotAfterReopen) {
        const settled = await this.waitForDropdownSnapshot(
          reopenCmds,
          `drag-reopen:${scrollAttempt}`,
          2500,
        );
        stepCommands.push(...settled.commands);
        snapshotAfterReopen = settled.snapshot;
        snapshotSourceCommands = [...reopenCmds, ...settled.commands];
      }

      if (!snapshotAfterReopen) {
        throw new Error(`Drag reopen produced no stable snapshot: light=${lightId}, index=${index}, target=${targetFirstVisible}, scrollAttempt=${scrollAttempt}`);
      }
      this.dropdownFirstVisible = snapshotAfterReopen.firstVisible;
      this.dropdownHandleCenterY = snapshotAfterReopen.handleCenterY;
      latestSnapshot = snapshotAfterReopen;
      latestSnapshotCommands = snapshotSourceCommands;

      if (this.isDropdownIndexVisible(index)) {
        logger.info({ scrollAttempt, firstVisible: this.dropdownFirstVisible, index }, 'Target visible after scroll');
      } else {
        logger.warn({ scrollAttempt, firstVisible: this.dropdownFirstVisible, targetFirstVisible, index }, 'Target not visible after reopen — will re-drag');
      }
    }

    if (!this.isDropdownIndexVisible(index)) {
      throw new Error(`Scroll failed after ${maxScrollAttempts} drag attempts: light=${lightId}, index=${index}, firstVisible=${this.dropdownFirstVisible}, target=${targetFirstVisible}`);
    }

    const reliableSnapshotResult = await this.waitForReliableDropdownSnapshot(
      latestSnapshotCommands,
      `pre-click:${lightId}`,
      index,
      2000,
      undefined,
      true,
    );
    stepCommands.push(...reliableSnapshotResult.commands);
    let reliableSnapshot = reliableSnapshotResult.snapshot;
    if (reliableSnapshotResult.closedDetected) {
      logger.warn({ lightId, index }, 'Dropdown closed before item click; reopening once');
      const { snapshot: reopenSnapshot, commands: reopenCmds } = await this.reopenDropdownFromClosed(`pre-click-reopen:${lightId}`);
      stepCommands.push(...reopenCmds);
      latestSnapshotCommands = [...latestSnapshotCommands, ...reliableSnapshotResult.commands, ...reopenCmds];
      let resolvedAfterReopen: DropdownSnapshot | null = reopenSnapshot;
      if (!this.isSnapshotReliableForIndex(resolvedAfterReopen, index)) {
        const settled = await this.waitForReliableDropdownSnapshot(
          reopenCmds,
          `pre-click-reopen:${lightId}`,
          index,
          2000,
          undefined,
          true,
        );
        stepCommands.push(...settled.commands);
        latestSnapshotCommands = [...latestSnapshotCommands, ...settled.commands];
        resolvedAfterReopen = settled.snapshot;
      }
      reliableSnapshot = resolvedAfterReopen;
    } else {
      latestSnapshotCommands = [...latestSnapshotCommands, ...reliableSnapshotResult.commands];
    }

    if (!reliableSnapshot) {
      throw new Error(`No reliable dropdown snapshot before item click: light=${lightId}, index=${index}`);
    }
    latestSnapshot = reliableSnapshot;
    this.dropdownFirstVisible = latestSnapshot.firstVisible;
    this.dropdownHandleCenterY = latestSnapshot.handleCenterY;

    // Step 4: Resolve click coordinates from the latest snapshot.
    // Use the label positions already captured from the dropdown open or
    // post-drag reopen response.
    const positionInView = index - this.dropdownFirstVisible;
    const visibleItems = dropdownConfig.visibleItems;
    if (positionInView < 0 || positionInView >= visibleItems) {
      throw new Error(`Dropdown row out of view after scroll: light=${lightId}, position=${positionInView}`);
    }
    // Use the known-good dropdown row X from UI calibration.
    const rowClickX = dropdownConfig.itemX;

    let itemY: number;
    let clickSource: string;

    const targetLabel = latestSnapshot?.labels.find(l => l.index === index) ?? null;

    if (targetLabel) {
      // Click at the vertical center of the text label. The PLC renders text
      // in the upper portion of each item row — the text center is the most
      // reliable click target.
      itemY = Math.round((targetLabel.top + targetLabel.bottom) / 2);
      clickSource = 'snapshot-label-center';
    } else {
      // Fallback: compute from the item grid with a 1/3-height offset
      // (text sits in the upper portion of each row).
      itemY = dropdownConfig.firstItemY + (positionInView * dropdownConfig.itemHeight) + Math.round(dropdownConfig.itemHeight / 3);
      clickSource = 'computed-row';
    }

    const touchValidatedTarget = this.resolveTouchValidatedDropdownClickY(
      latestSnapshotCommands,
      positionInView,
      rowClickX,
      itemY,
    );
    itemY = touchValidatedTarget.y;
    if (touchValidatedTarget.usedTouchRectangles) {
      clickSource = `${clickSource}+${touchValidatedTarget.source}`;
    }

    logger.info({
      lightId,
      index,
      positionInView,
      clickY: itemY,
      clickSource,
      touchRectanglesUsed: touchValidatedTarget.usedTouchRectangles,
      touchRectanglesInRow: touchValidatedTarget.targetRowRectCount,
      touchRectanglesTotalRows: touchValidatedTarget.totalRowRectCount,
    }, 'Selecting dropdown item');

    // Step 5: Selection gesture with fallback for latency-heavy runs.
    // Primary: direct press gesture.
    // Fallback: re-open + press gesture to recover stale hitboxes.
    let selectionResult = await this.selectDropdownItemAndCollect(
      lightId,
      rowClickX,
      itemY,
      'press-primary',
    );
    stepCommands.push(...selectionResult.commands);
    let headerLabel = selectionResult.headerLabel;
    if (!this.isExpectedDropdownHeader(index, headerLabel)) {
      if (headerLabel !== null) {
        this.opportunisticallyCacheStatus(selectionResult.commands, headerLabel);
      }
      const fallbackResult = await this.tryFallbackDropdownSelection(
        lightId,
        index,
        dropdownConfig,
        rowClickX,
      );
      if (fallbackResult) {
        stepCommands.push(...fallbackResult.preCommands);
        stepCommands.push(...fallbackResult.selection.commands);
        selectionResult = fallbackResult.selection;
        headerLabel = fallbackResult.selection.headerLabel;
        if (!this.isExpectedDropdownHeader(index, headerLabel) && headerLabel !== null) {
          this.opportunisticallyCacheStatus(fallbackResult.selection.commands, headerLabel);
        }
      }
    }

    // Step 6: Verify the dropdown header now shows the expected item.
    this.verifyDropdownHeader(selectionResult.commands, lightId, index);

    logger.info(`Light switch ${lightId} selected`);
    return { allCommands: stepCommands, postSelectionCommands: selectionResult.commands };
  }

  async toggleLight(lightId: string, functionNumber: 1 | 2 = 1): Promise<void> {
    return this.queueOperation(async () => {
      this.ensureInitialized();
      logger.info(`Toggling light: ${lightId} (function ${functionNumber})`);

      await this.doSelectLightSwitch(lightId);

      const togglePostClickDelayMs = Math.max(0, config.protocol?.togglePostClickDelayMs ?? 500);

      const firstButton = uiCoordinates.lightSwitches.ohjausButton;
      const lightSwitchUi = uiCoordinates.lightSwitches as typeof uiCoordinates.lightSwitches & {
        ohjausButton2?: { x: number; y: number };
      };
      const configuredSecondButton = lightSwitchUi.ohjausButton2;
      const secondButton = configuredSecondButton ?? { x: firstButton.x, y: firstButton.y + 30 };
      const targetButton = functionNumber === 2 ? secondButton : firstButton;
      const buttonSource = functionNumber === 2
        ? (configuredSecondButton ? 'configured-second' : 'estimated-second')
        : 'primary';
      if (functionNumber === 2 && !configuredSecondButton) {
        logger.warn({ lightId, x: targetButton.x, y: targetButton.y }, 'Function 2 toggle using estimated second button coordinate');
      }

      logger.info({
        lightId,
        functionNumber,
        x: targetButton.x,
        y: targetButton.y,
        buttonSource,
      }, 'Dispatching toggle button click');

      const clickCommands = await this.client.pressAndCollect(targetButton.x, targetButton.y);

      if (togglePostClickDelayMs > 0) {
        await this.delay(togglePostClickDelayMs);
      }

      const postRenderPolls = config.protocol?.togglePostRenderPolls ?? 2;
      const postRenderPollDelayMs = config.protocol?.togglePostRenderPollDelayMs ?? 0;
      let totalPostCommands = 0;
      for (let i = 0; i < postRenderPolls; i++) {
        if (i > 0 && postRenderPollDelayMs > 0) await this.delay(postRenderPollDelayMs);
        const postCommands = await this.pollPaintCommands(`toggle-post:${lightId}:${i}`);
        totalPostCommands += postCommands.length;
      }

      logger.info({
        lightId,
        functionNumber,
        clickCommandCount: clickCommands.length,
        postRenderPolls,
        totalPostCommands,
      }, 'Toggle render settle complete');

      logger.info(`Light ${lightId} function ${functionNumber} toggled`);
    });
  }

  async getLightStatus(lightId: string): Promise<LightStatus> {
    return this.queueOperation(async () => {
      this.ensureInitialized();

      const index = lightSwitches[lightId];
      if (index === undefined) {
        throw new Error(`Unknown light switch: ${lightId}`);
      }

      const switchInfo = lightSwitchById[lightId];
      const firstPressLightId = (switchInfo as any)?.firstPressLightId as string | undefined;
      const secondPressLightId = (switchInfo as any)?.secondPressLightId as string | undefined;
      const hasDualFunction = !!secondPressLightId;
      const switchName = lightSwitchNames[index] || lightId;

      const { postSelectionCommands } = await this.doSelectLightSwitch(lightId);
      const selectionSettleDelayMs = config.protocol?.selectionSettleDelayMs ?? 200;
      if (selectionSettleDelayMs > 0) {
        await this.delay(selectionSettleDelayMs);
      }
      const statusCommands = await this.pollPaintCommands(`status:${lightId}`);

      // Only use post-selection commands + status poll for lamp resolution.
      // Using the full command history (including drag/reopen phases) would
      // pick up stale lamp images from before the correct item was selected.
      const statusRelevantCommands = [...postSelectionCommands, ...statusCommands];

      const indicatorImages = this.resolveIndicatorImages(statusRelevantCommands);

      // Use physical light IDs as cache keys so that multiple switches controlling
      // the same light share one entry (cache hits propagate between switches).
      const key1 = firstPressLightId ?? `${lightId}:1`;
      const key2 = secondPressLightId ?? `${lightId}:2`;

      let isOn1 = this.resolveLampStatus(indicatorImages.indicator1);
      if (isOn1 === null) {
        const cached = this.lastStatusByLight.get(key1);
        if (cached !== undefined) {
          isOn1 = cached;
          logger.info(`No fresh lamp redraw for ${lightId} indicator 1 (light: ${key1}), using cached=${cached}`);
        } else {
          isOn1 = false;
          logger.warn(`No lamp image found for ${lightId} indicator 1 (light: ${key1}), defaulting to OFF`);
        }
      }
      this.lastStatusByLight.set(key1, isOn1);
      logger.info(`Status indicator 1 for ${lightId} (light: ${key1}): images=${JSON.stringify(this.formatImageSummary(indicatorImages.indicator1))}, isOn=${isOn1}`);

      let resolved2 = this.resolveLampStatus(indicatorImages.indicator2);
      if (resolved2 === null) {
        const cached = this.lastStatusByLight.get(key2);
        if (cached !== undefined) {
          resolved2 = cached;
          logger.info(`No fresh lamp redraw for ${lightId} indicator 2 (light: ${key2}), using cached=${cached}`);
        } else {
          resolved2 = false;
        }
      }
      this.lastStatusByLight.set(key2, resolved2);
      logger.info(`Status indicator 2 for ${lightId} (light: ${key2}): images=${JSON.stringify(this.formatImageSummary(indicatorImages.indicator2))}, isOn=${resolved2}`);

      // indicator3 has no light ID mapping — cache under switch-specific key
      let resolved3 = this.resolveLampStatus(indicatorImages.indicator3);
      if (resolved3 === null) {
        const cached = this.lastStatusByLight.get(`${lightId}:3`);
        if (cached !== undefined) {
          resolved3 = cached;
        } else {
          resolved3 = false;
        }
      }
      this.lastStatusByLight.set(`${lightId}:3`, resolved3);

      let isOn2: boolean | undefined;
      if (hasDualFunction) {
        isOn2 = resolved2;
      }

      return {
        id: lightId,
        name: switchName,
        isOn: isOn1,
        ...(isOn2 !== undefined ? { isOn2 } : {}),
      };
    });
  }

  async getAllLights(): Promise<LightStatus[]> {
    const lights: LightStatus[] = [];

    for (const [id, index] of Object.entries(lightSwitches)) {
      try {
        const status = await this.getLightStatus(id);
        lights.push(status);
      } catch (error) {
        logger.error(`Error getting status for light ${id}: ${error}`);
        lights.push({
          id,
          name: lightSwitchNames[index] || id,
          isOn: false,
        });
      }
    }

    return lights;
  }

  async takeScreenshot(): Promise<Buffer> {
    if (!this.debugRenderer) {
      logger.warn('takeScreenshot() requires PROTOCOL_DEBUG_RENDER=true in protocol mode');
      return Buffer.alloc(0);
    }

    let latest = this.debugRenderer.getLatestPng();

    if (!this.initialized) {
      logger.warn('takeScreenshot() requested before protocol controller initialization');
      return latest ?? Buffer.alloc(0);
    }

    try {
      const maxAttempts = 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const commands = await this.pollPaintCommands(`manual-screenshot:${attempt}`);
        const rendered = await this.debugRenderer.renderPreview(commands);
        latest = rendered;

        if (commands.length > 0) {
          return rendered;
        }

      }
      return latest ?? Buffer.alloc(0);
    } catch (error) {
      logger.warn({ error }, 'Failed to generate protocol debug screenshot');
      return latest ?? Buffer.alloc(0);
    }
  }

  async getRenderedUiImage(): Promise<Buffer | null> {
    if (!this.debugRenderer) {
      return null;
    }
    // renderPreview([]) renders the current accumulated surface state without
    // applying any new commands. Always returns a PNG even in no-disk mode.
    return this.debugRenderer.renderPreview([]);
  }

  async isConnected(): Promise<boolean> {
    return this.client.isConnected();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Protocol controller not initialized. Call initialize() first.');
    }
  }

  private async queueOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations++;
    try {
      const result = this.operationQueue.then(operation);
      this.operationQueue = result.catch(() => {});
      return await result;
    } finally {
      this.pendingOperations--;
    }
  }

  private normalizeImageId(imageId: string): string {
    return imageId.toLowerCase().replace(/\x00+$/g, '').trim();
  }

  private isLampStatusImageId(imageId: string): boolean {
    const normalized = this.normalizeImageId(imageId);
    return normalized === LAMP_IMAGE_OFF || normalized === LAMP_IMAGE_ON;
  }

  private normalizeVisuText(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\x00+$/g, '')
      .replace(/\s+/g, '')  // Collapse all whitespace — the PLC often strips spaces in text rendering
      .trim();
  }

  private async waitForInitialRenderReady(): Promise<PaintCommand[]> {
    const timeoutMs = Math.max(
      ProtocolController.MIN_INITIAL_RENDER_TIMEOUT_MS,
      config.protocol?.initialRenderTimeoutMs ?? ProtocolController.DEFAULT_INITIAL_RENDER_TIMEOUT_MS,
    );
    const pollIntervalMs = Math.max(
      ProtocolController.MIN_INITIAL_RENDER_POLL_INTERVAL_MS,
      config.protocol?.initialRenderPollIntervalMs ?? ProtocolController.DEFAULT_INITIAL_RENDER_POLL_INTERVAL_MS,
    );
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const accumulated: PaintCommand[] = [];
    let attempt = 0;

    while (Date.now() <= deadline) {
      attempt++;
      const commands = await this.pollPaintCommands(`initial-render:${attempt}`);
      accumulated.push(...commands);
      const images = extractDrawImages(accumulated);
      const labels = extractTextLabels(accumulated);
      const topLabels = labels.filter((label) => label.top <= 55 && label.bottom <= 75);
      logger.info({
        reason: 'initialize',
        attempt,
        imageCount: images.length,
        topLabelCount: topLabels.length,
      }, 'Initial render probe');

      if (images.length > 0 || topLabels.length > 0) {
        logger.info({ attempts: attempt, elapsedMs: Date.now() - startedAt }, 'Initial render ready');
        return accumulated;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await this.delay(Math.min(pollIntervalMs, remainingMs));
    }

    logger.warn({
      attempts: attempt,
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
    }, 'Initial render did not become ready; continuing');
    return accumulated;
  }

  private getDropdownMaxFirstVisible(): number {
    return Math.max(0, lightSwitchList.length - uiCoordinates.lightSwitches.dropdownList.visibleItems);
  }

  private isDropdownIndexVisible(index: number): boolean {
    const visibleItems = uiCoordinates.lightSwitches.dropdownList.visibleItems;
    return index >= this.dropdownFirstVisible && index < this.dropdownFirstVisible + visibleItems;
  }

  private getTargetFirstVisible(index: number, maxFirstVisible: number): number {
    const visibleItems = uiCoordinates.lightSwitches.dropdownList.visibleItems;
    // Center the target in the visible range. This gives ±2 positions of tolerance
    // for the reopen overshoot (the PLC often jumps 1-2 positions when the dropdown
    // is closed and reopened after a scrollbar drag).
    const centerOffset = Math.floor(visibleItems / 2);
    const preferredFirstVisible = Math.min(Math.max(0, index - centerOffset), maxFirstVisible);
    const minimumFirstVisible = Math.max(0, index - (visibleItems - 1));
    return Math.max(minimumFirstVisible, Math.min(preferredFirstVisible, maxFirstVisible));
  }

  private extractDropdownHeaderLabel(commands: PaintCommand[]): string | null {
    const { dropdownList, dropdownArrow } = uiCoordinates.lightSwitches;
    const labels = extractTextLabels(commands);
    // Header area: above the list (bottom < firstItemY), below the tab bar (top > 50),
    // and within the dropdown width (left < arrow button X).
    const headerLabels = labels.filter(
      (label) =>
        label.bottom < dropdownList.firstItemY &&
        label.top > 50 &&
        label.left < dropdownArrow.x
    );
    if (headerLabels.length === 0) return null;
    // Return the last (most recently drawn) label in case of duplicates.
    return headerLabels[headerLabels.length - 1].text;
  }

  private isExpectedDropdownHeader(index: number, headerLabel: string | null): boolean {
    if (headerLabel === null) {
      return false;
    }
    const expectedPlcLabel = lightSwitchPlcLabels[index];
    const expectedName = lightSwitchNames[index];
    const normalizedHeader = this.normalizeVisuText(headerLabel);
    const matchesPlcLabel = expectedPlcLabel && this.normalizeVisuText(expectedPlcLabel) === normalizedHeader;
    const matchesName = expectedName && this.normalizeVisuText(expectedName) === normalizedHeader;
    return !!(matchesPlcLabel || matchesName);
  }

  private buildDropdownHeaderError(lightId: string, index: number, headerLabel: string | null): DropdownHeaderMismatchError {
    const expectedPlcLabel = lightSwitchPlcLabels[index];
    const expectedName = lightSwitchNames[index];
    return new DropdownHeaderMismatchError({
      lightId,
      index,
      expectedPlcLabel,
      expectedName,
      actualHeaderLabel: headerLabel,
      mismatchKind: headerLabel === null ? 'missing' : 'mismatch',
    });
  }

  private verifyDropdownHeader(commands: PaintCommand[], lightId: string, index: number): void {
    const headerLabel = this.extractDropdownHeaderLabel(commands);
    if (!this.isExpectedDropdownHeader(index, headerLabel)) {
      throw this.buildDropdownHeaderError(lightId, index, headerLabel);
    }
    logger.info({ lightId, index, headerText: headerLabel }, 'Header verification passed');
  }

  private async selectDropdownItemAndCollect(
    lightId: string,
    itemX: number,
    itemY: number,
    strategy: DropdownSelectionResult['strategy'],
  ): Promise<DropdownSelectionResult> {
    const selectCommands: PaintCommand[] = [];
    const selectionSettleMs = Math.max(0, config.protocol?.selectionSettleDelayMs ?? 200);

    const pressCmds = await this.client.mouseDownAndCollect(itemX, itemY);
    selectCommands.push(...pressCmds);

    if (strategy === 'press-primary') {
      if (selectionSettleMs > 0) {
        await this.delay(selectionSettleMs);
      }
    } else {
      const fallbackSettleMs = Math.max(250, selectionSettleMs + 150);
      if (fallbackSettleMs > 0) {
        await this.delay(fallbackSettleMs);
      }
    }

    const pollPrefix = strategy === 'press-primary' ? 'select-settle' : 'select-fallback-settle';
    const extraPrefix = strategy === 'press-primary' ? 'select-extra' : 'select-fallback-extra';
    const headerPollTimeoutMs = strategy === 'press-primary' ? 3000 : 3500;
    const headerPollDeadline = Date.now() + headerPollTimeoutMs;
    let headerLabel: string | null = this.extractDropdownHeaderLabel(selectCommands);
    let headerPolls = 0;

    while (headerLabel === null && Date.now() < headerPollDeadline) {
      headerPolls++;
      const cmds = await this.pollPaintCommands(`${pollPrefix}:${headerPolls}:${lightId}`);
      selectCommands.push(...cmds);
      headerLabel = this.extractDropdownHeaderLabel(selectCommands);
      if (headerLabel !== null) break;
      const remaining = headerPollDeadline - Date.now();
      if (remaining > 0) await this.delay(Math.min(150, remaining));
    }

    if (headerLabel !== null) {
      const extraCmds = await this.pollPaintCommands(`${extraPrefix}:${lightId}`);
      selectCommands.push(...extraCmds);
    }

    return {
      commands: selectCommands,
      headerLabel,
      strategy,
    };
  }

  private async tryFallbackDropdownSelection(
    lightId: string,
    index: number,
    dropdownConfig: typeof uiCoordinates.lightSwitches.dropdownList,
    rowClickX: number,
  ): Promise<{ preCommands: PaintCommand[]; selection: DropdownSelectionResult } | null> {
    logger.warn({ lightId, index }, 'Primary selection mismatch; attempting fallback press gesture');

    const preCommands: PaintCommand[] = [];
    const { snapshot: reopenSnapshot, commands: reopenCmds } = await this.reopenDropdownFromClosed(`select-fallback:${lightId}`);
    preCommands.push(...reopenCmds);

    let snapshot: DropdownSnapshot | null = reopenSnapshot;
    if (!this.isSnapshotReliableForIndex(snapshot, index)) {
      const settled = await this.waitForReliableDropdownSnapshot(
        reopenCmds,
        `select-fallback:${lightId}`,
        index,
        2500,
        undefined,
        true,
      );
      preCommands.push(...settled.commands);
      if (settled.closedDetected) {
        logger.warn({ lightId, index }, 'Fallback selection aborted: dropdown closed while waiting for reliable snapshot');
        return null;
      }
      snapshot = settled.snapshot;
    }

    if (!snapshot) {
      logger.warn({ lightId, index }, 'Fallback selection aborted: no reliable dropdown snapshot');
      return null;
    }

    this.dropdownFirstVisible = snapshot.firstVisible;
    this.dropdownHandleCenterY = snapshot.handleCenterY;
    const positionInView = index - snapshot.firstVisible;
    if (positionInView < 0 || positionInView >= dropdownConfig.visibleItems) {
      logger.warn({ lightId, index, firstVisible: snapshot.firstVisible }, 'Fallback selection aborted: target row not visible');
      return null;
    }

    const fallbackY = dropdownConfig.firstItemY +
      (positionInView * dropdownConfig.itemHeight) +
      Math.round(dropdownConfig.itemHeight / 2);
    const touchValidatedTarget = this.resolveTouchValidatedDropdownClickY(
      preCommands,
      positionInView,
      rowClickX,
      fallbackY,
    );
    const selection = await this.selectDropdownItemAndCollect(
      lightId,
      rowClickX,
      touchValidatedTarget.y,
      'press-fallback',
    );

    return { preCommands, selection };
  }

  private opportunisticallyCacheStatus(commands: PaintCommand[], actualHeaderLabel: string): void {
    const actualIndex = this.resolveLightIndexFromLabel(actualHeaderLabel);
    if (actualIndex === null) {
      logger.warn({ actualHeaderLabel }, 'Opportunistic cache: could not resolve switch index from header label');
      return;
    }

    const sw = lightSwitchList.find(s => s.index === actualIndex);
    if (!sw) {
      logger.warn({ actualIndex, actualHeaderLabel }, 'Opportunistic cache: switch not found in list');
      return;
    }

    const indicatorImages = this.resolveIndicatorImages(commands);
    const firstPressLightId = (sw as any).firstPressLightId as string | undefined;
    const secondPressLightId = (sw as any).secondPressLightId as string | undefined;

    const key1 = firstPressLightId ?? `${sw.id}:1`;
    const isOn1 = this.resolveLampStatus(indicatorImages.indicator1);
    if (isOn1 !== null) this.lastStatusByLight.set(key1, isOn1);

    const key2 = secondPressLightId ?? `${sw.id}:2`;
    const isOn2 = secondPressLightId ? this.resolveLampStatus(indicatorImages.indicator2) : null;
    if (isOn2 !== null) this.lastStatusByLight.set(key2, isOn2);

    logger.info({
      switchId: sw.id,
      actualHeaderLabel,
      indicator1: { key: key1, isOn: isOn1 },
      ...(secondPressLightId ? { indicator2: { key: key2, isOn: isOn2 } } : {}),
    }, 'Opportunistically cached status for accidentally-selected switch');
  }

  private getDropdownScrollY(firstVisible: number, maxFirstVisible: number = this.getDropdownMaxFirstVisible()): number {
    const topY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;
    const bottomY = uiCoordinates.lightSwitches.scrollbar.thumbRange.bottomY;
    if (maxFirstVisible <= 0 || firstVisible <= 0) return topY;
    if (firstVisible >= maxFirstVisible) return bottomY;
    return topY + (((bottomY - topY) * firstVisible) / maxFirstVisible);
  }

  private getDropdownSnapshotWindow(commands: PaintCommand[]): PaintCommand[] {
    const maxCommands = ProtocolController.DROPDOWN_SNAPSHOT_WINDOW_COMMANDS;
    if (commands.length <= maxCommands) {
      return [...commands];
    }
    return commands.slice(-maxCommands);
  }

  private isSnapshotWithinBounds(
    snapshot: DropdownSnapshot | null,
    bounds?: DropdownSnapshotBounds,
  ): snapshot is DropdownSnapshot {
    if (!snapshot) {
      return false;
    }
    if (!bounds) {
      return true;
    }
    return snapshot.firstVisible >= bounds.minFirstVisible &&
      snapshot.firstVisible <= bounds.maxFirstVisible;
  }

  private resolveLightIndexFromLabel(text: string): number | null {
    const normalized = this.normalizeVisuText(text);
    if (!normalized) {
      return null;
    }
    for (const light of lightSwitchList) {
      if (this.normalizeVisuText(light.name) === normalized) return light.index;
      const plcLabel = (light as { plcLabel?: string }).plcLabel;
      if (plcLabel && this.normalizeVisuText(plcLabel) === normalized) return light.index;
    }
    return null;
  }

  private resolveDropdownSnapshot(commands: PaintCommand[]): {
    firstVisible: number;
    handleCenterY: number;
    labels: Array<{ text: string; index: number; top: number; bottom: number; row: number }>;
  } | null {
    const dropdown = uiCoordinates.lightSwitches.dropdownList;
    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const labels = extractTextLabels(commands);
    // Use the same tight Y bounds as isDropdownOpen to avoid header/panel label contamination.
    const listTop = dropdown.firstItemY;
    const listBottom = dropdown.firstItemY + (dropdown.itemHeight * dropdown.visibleItems);
    const listLeft = Math.max(0, dropdown.itemX - 260);
    const listRight = arrowX + 8;
    const maxFirstVisible = this.getDropdownMaxFirstVisible();

    const matched = labels
      .map((label, drawOrder) => ({ label, drawOrder }))
      .filter(({ label }) => label.top >= listTop && label.bottom <= listBottom)
      .filter(({ label }) => label.right >= listLeft && label.left <= listRight)
      .map(({ label, drawOrder }) => {
        const index = this.resolveLightIndexFromLabel(label.text);
        if (index === null) return null;
        const centerY = Math.round((label.top + label.bottom) / 2);
        // Use Math.floor: text centers are in the upper portion of each row,
        // so floor correctly assigns them (round could overshoot at 0.5 boundary).
        const row = Math.floor((centerY - dropdown.firstItemY) / dropdown.itemHeight);
        return {
          text: label.text,
          index,
          top: label.top,
          bottom: label.bottom,
          row,
          candidate: index - row,
          drawOrder,
        };
      })
      .filter((item): item is {
        text: string;
        index: number;
        top: number;
        bottom: number;
        row: number;
        candidate: number;
        drawOrder: number;
      } => !!item)
      .filter((item) => item.row >= 0 && item.row < dropdown.visibleItems)
      .filter((item) => item.candidate >= 0 && item.candidate <= maxFirstVisible)
      .sort((a, b) => a.top - b.top || a.index - b.index);

    if (matched.length === 0) {
      logger.debug({ totalLabels: labels.length, listTop, listBottom, listLeft, listRight }, 'resolveDropdownSnapshot: no matched labels');
      return null;
    }

    const groups = new Map<number, typeof matched>();
    for (const item of matched) {
      const existing = groups.get(item.candidate);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(item.candidate, [item]);
      }
    }

    const ranked = [...groups.entries()]
      .map(([candidate, items]) => {
        const rows = new Set(items.map((item) => item.row));
        return {
          candidate,
          items,
          distinctRows: rows.size,
          latestDrawOrder: Math.max(...items.map((item) => item.drawOrder)),
        };
      })
      .sort((a, b) => {
        // Prefer the most recently drawn candidate to avoid stale labels from
        // earlier command chunks dominating dropdown state inference.
        if (b.latestDrawOrder !== a.latestDrawOrder) return b.latestDrawOrder - a.latestDrawOrder;
        if (b.distinctRows !== a.distinctRows) return b.distinctRows - a.distinctRows;
        if (b.items.length !== a.items.length) return b.items.length - a.items.length;
        return Math.abs(a.candidate - this.dropdownFirstVisible) - Math.abs(b.candidate - this.dropdownFirstVisible);
      });

    const best = ranked[0];
    if (!best || best.distinctRows < 2) {
      logger.debug({
        matchedCount: matched.length,
        matched: matched.map(m => ({ text: m.text, index: m.index, row: m.row, top: m.top, candidate: m.candidate })),
        bestCandidate: best?.candidate,
        bestDistinctRows: best?.distinctRows,
        bestItemCount: best?.items.length,
      }, 'resolveDropdownSnapshot: insufficient distinct rows');
      return null;
    }

    const firstVisible = best.candidate;
    const rowMap = new Map<number, (typeof matched)[number]>();
    for (const item of best.items) {
      const expectedIndex = firstVisible + item.row;
      const existing = rowMap.get(item.row);
      if (!existing) {
        rowMap.set(item.row, item);
        continue;
      }
      const existingDelta = Math.abs(existing.index - expectedIndex);
      const candidateDelta = Math.abs(item.index - expectedIndex);
      if (candidateDelta < existingDelta || (candidateDelta === existingDelta && item.top > existing.top)) {
        rowMap.set(item.row, item);
        continue;
      }
      if (candidateDelta === existingDelta && item.drawOrder > existing.drawOrder) {
        rowMap.set(item.row, item);
      }
    }

    const labelsForSnapshot = [...rowMap.values()]
      .sort((a, b) => a.row - b.row || a.top - b.top || a.index - b.index)
      .map((item) => ({
        text: item.text,
        index: item.index,
        top: item.top,
        bottom: item.bottom,
        row: item.row,
      }));

    return {
      firstVisible,
      handleCenterY: this.getDropdownScrollY(firstVisible, maxFirstVisible),
      labels: labelsForSnapshot,
    };
  }

  private resolveDropdownRowTouchRectangles(commands: PaintCommand[]): Array<{ row: number; rect: TouchRectangleCommand }> {
    const dropdown = uiCoordinates.lightSwitches.dropdownList;
    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const listTop = dropdown.firstItemY;
    const listBottom = dropdown.firstItemY + (dropdown.itemHeight * dropdown.visibleItems) - 1;
    const listLeft = Math.max(0, dropdown.itemX - 260);
    const listRight = arrowX + 8;

    const latestTouchRects = extractLatestTouchRectangles(commands);
    if (latestTouchRects.length === 0) {
      return [];
    }

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

  private resolveTouchValidatedDropdownClickY(
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
    const rowTouchRects = this.resolveDropdownRowTouchRectangles(commands);
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

  private syncDropdownStateFromCommands(commands: PaintCommand[], reason: string): boolean {
    const snapshot = this.resolveDropdownSnapshot(commands);
    if (!snapshot) {
      return false;
    }

    const previousFirstVisible = this.dropdownFirstVisible;
    this.dropdownFirstVisible = snapshot.firstVisible;
    this.dropdownHandleCenterY = snapshot.handleCenterY;

    if (previousFirstVisible !== snapshot.firstVisible) {
      const handleTop = Math.round(snapshot.handleCenterY - 4);
      const handleBottom = handleTop + 9;
      logger.info({
        reason,
        firstVisible: snapshot.firstVisible,
        handleCenterY: Math.round(snapshot.handleCenterY),
        handleTopY: handleTop,
        handleBottomY: handleBottom,
        labels: snapshot.labels.slice(0, 5),
      }, 'Detected dropdown scrollbar handle');
    }
    return true;
  }

  private async waitForDropdownSnapshot(
    seedCommands: PaintCommand[],
    reason: string,
    timeoutMs: number,
    bounds?: DropdownSnapshotBounds,
  ): Promise<{
    snapshot: DropdownSnapshot | null;
    commands: PaintCommand[];
    closedDetected: boolean;
  }> {
    let window = this.getDropdownSnapshotWindow(seedCommands);
    const additional: PaintCommand[] = [];
    let snapshot = this.resolveDropdownSnapshot(window);
    if (!this.isSnapshotWithinBounds(snapshot, bounds)) {
      snapshot = null;
    }
    let closedDetected = false;
    let closedSignalStreak = 0;
    let stableFirstVisible: number | null = snapshot?.firstVisible ?? null;
    let stableSnapshotStreak = snapshot ? 1 : 0;

    if (timeoutMs <= 0) {
      return { snapshot, commands: additional, closedDetected };
    }

    const deadline = Date.now() + timeoutMs;
    let poll = 0;
    while (Date.now() < deadline && !closedDetected) {
      poll++;
      const cmds = await this.pollPaintCommands(`dropdown-snapshot:${reason}:${poll}`);
      additional.push(...cmds);
      window = this.getDropdownSnapshotWindow([...window, ...cmds]);

      const candidate = this.resolveDropdownSnapshot(window);
      if (this.isSnapshotWithinBounds(candidate, bounds)) {
        snapshot = candidate;
        if (stableFirstVisible === candidate.firstVisible) {
          stableSnapshotStreak++;
        } else {
          stableFirstVisible = candidate.firstVisible;
          stableSnapshotStreak = 1;
        }
      } else {
        stableSnapshotStreak = 0;
      }

      const closedSignal = this.isDropdownDefinitivelyClosed(cmds);
      if (closedSignal) {
        closedSignalStreak++;
      } else {
        closedSignalStreak = 0;
      }
      closedDetected = closedSignalStreak >= ProtocolController.DROPDOWN_CLOSED_SIGNAL_STREAK;

      if (closedDetected || (snapshot !== null && stableSnapshotStreak >= 2)) {
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await this.delay(Math.min(150, remaining));
      }
    }

    return { snapshot, commands: additional, closedDetected };
  }

  private isSnapshotReliableForIndex(snapshot: DropdownSnapshot | null, index: number): snapshot is DropdownSnapshot {
    if (!snapshot) {
      return false;
    }

    const visibleItems = uiCoordinates.lightSwitches.dropdownList.visibleItems;
    const targetRow = index - snapshot.firstVisible;
    if (targetRow < 0 || targetRow >= visibleItems) {
      return false;
    }

    const validRows = new Set<number>();
    for (const label of snapshot.labels) {
      if (label.index !== snapshot.firstVisible + label.row) {
        continue;
      }
      validRows.add(label.row);
    }

    if (!validRows.has(targetRow)) {
      return false;
    }

    // Some PLC renders intermittently omit one row label while the dropdown is
    // still usable. Require only a small supporting set of consistent rows.
    const minSupportingRows = targetRow === 0 || targetRow === visibleItems - 1 ? 2 : 3;
    return validRows.size >= minSupportingRows;
  }

  private async waitForReliableDropdownSnapshot(
    seedCommands: PaintCommand[],
    reason: string,
    index: number,
    timeoutMs: number,
    bounds?: DropdownSnapshotBounds,
    requireFreshConfirmation: boolean = false,
  ): Promise<{
    snapshot: DropdownSnapshot | null;
    commands: PaintCommand[];
    closedDetected: boolean;
  }> {
    let window = this.getDropdownSnapshotWindow(seedCommands);
    const additional: PaintCommand[] = [];
    let snapshot = this.resolveDropdownSnapshot(window);
    if (!this.isSnapshotWithinBounds(snapshot, bounds)) {
      snapshot = null;
    }
    let closedDetected = false;
    let closedSignalStreak = 0;
    const requiredReliableStreak = requireFreshConfirmation ? 2 : 1;
    let reliableStreak = this.isSnapshotReliableForIndex(snapshot, index) ? 1 : 0;
    if (timeoutMs <= 0) {
      return { snapshot, commands: additional, closedDetected };
    }
    if (!requireFreshConfirmation && reliableStreak >= requiredReliableStreak) {
      return { snapshot, commands: additional, closedDetected };
    }

    const deadline = Date.now() + timeoutMs;
    let poll = 0;
    while (Date.now() < deadline && !closedDetected) {
      poll++;
      const cmds = await this.pollPaintCommands(`dropdown-snapshot-reliable:${reason}:${poll}`);
      additional.push(...cmds);
      window = this.getDropdownSnapshotWindow([...window, ...cmds]);

      const closedSignal = this.isDropdownDefinitivelyClosed(cmds);
      if (closedSignal) {
        closedSignalStreak++;
      } else {
        closedSignalStreak = 0;
      }
      closedDetected = closedSignalStreak >= ProtocolController.DROPDOWN_CLOSED_SIGNAL_STREAK;
      const candidate = this.resolveDropdownSnapshot(window);
      if (!this.isSnapshotWithinBounds(candidate, bounds)) {
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await this.delay(Math.min(150, remaining));
        }
        continue;
      }
      const hasFreshLabelSignal = extractTextLabels(cmds).length > 0;
      if (this.isSnapshotReliableForIndex(candidate, index)) {
        snapshot = candidate;
        if (!requireFreshConfirmation || hasFreshLabelSignal) {
          reliableStreak++;
        }
        if (reliableStreak >= requiredReliableStreak) {
          break;
        }
      } else {
        reliableStreak = 0;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await this.delay(Math.min(150, remaining));
      }
    }

    if (!this.isSnapshotReliableForIndex(snapshot, index)) {
      snapshot = null;
    }
    return { snapshot, commands: additional, closedDetected };
  }

  private collectLampImages(commands: PaintCommand[]): ImageDrawCommand[] {
    return extractDrawImages(commands)
      .filter((image) => this.isLampStatusImageId(image.imageId))
      .slice(-36);
  }

  private isPlausibleLampGeometry(image: ImageDrawCommand): boolean {
    const viewportWidth = config.browser.viewport.width;
    const viewportHeight = config.browser.viewport.height;
    return image.width > 0 &&
      image.height > 0 &&
      image.width <= 160 &&
      image.height <= 160 &&
      image.x >= -120 &&
      image.y >= -120 &&
      image.x <= viewportWidth + 120 &&
      image.y <= viewportHeight + 120;
  }

  private imageCenterDistance(image: ImageDrawCommand, at: { x: number; y: number }): number {
    const centerX = image.x + (image.width / 2);
    const centerY = image.y + (image.height / 2);
    const dx = centerX - at.x;
    const dy = centerY - at.y;
    return Math.sqrt((dx * dx) + (dy * dy));
  }

  private resolveIndicatorImages(commands: PaintCommand[]): {
    indicator1: ImageDrawCommand[];
    indicator2: ImageDrawCommand[];
    indicator3: ImageDrawCommand[];
  } {
    const lamps = this.collectLampImages(commands);
    const indexed = lamps.map((image, index) => ({ image, index }));
    const used = new Set<number>();

    const indicators = [
      { key: 'indicator1' as const, at: uiCoordinates.lightSwitches.statusIndicator },
      { key: 'indicator2' as const, at: uiCoordinates.lightSwitches.statusIndicator2 },
      { key: 'indicator3' as const, at: uiCoordinates.lightSwitches.statusIndicator3 },
    ];

    const resolved: {
      indicator1: ImageDrawCommand[];
      indicator2: ImageDrawCommand[];
      indicator3: ImageDrawCommand[];
    } = {
      indicator1: [],
      indicator2: [],
      indicator3: [],
    };

    for (const indicator of indicators) {
      const candidate = indexed
        .filter((entry) => !used.has(entry.index))
        .filter((entry) => this.isPlausibleLampGeometry(entry.image))
        .map((entry) => ({
          entry,
          distance: this.imageCenterDistance(entry.image, indicator.at),
        }))
        .filter((entry) => entry.distance <= 24)
        .sort((a, b) => a.distance - b.distance || b.entry.index - a.entry.index)[0];

      if (candidate) {
        used.add(candidate.entry.index);
        resolved[indicator.key] = [candidate.entry.image];
      }
    }

    const unresolved = indicators.filter((indicator) => resolved[indicator.key].length === 0);
    const remaining = indexed
      .filter((entry) => !used.has(entry.index))
      .filter((entry) => this.isPlausibleLampGeometry(entry.image));
    if (unresolved.length > 0 && remaining.length > 0) {
      const ordered = remaining.length === unresolved.length
        ? [...remaining].sort((a, b) => a.index - b.index)
        : [...remaining].sort((a, b) => b.index - a.index);
      const count = Math.min(unresolved.length, ordered.length);
      for (let i = 0; i < count; i++) {
        resolved[unresolved[i].key] = [ordered[i].image];
      }
    }

    return resolved;
  }

  private formatImageSummary(images: ImageDrawCommand[]): Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }> {
    return images.map((image) => ({
      id: image.imageId,
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
    }));
  }

  private resolveLampStatus(images: ImageDrawCommand[]): boolean | null {
    if (images.length === 0) return null;
    for (let i = images.length - 1; i >= 0; i--) {
      const id = this.normalizeImageId(images[i].imageId);
      if (id === LAMP_IMAGE_ON) return true;
      if (id === LAMP_IMAGE_OFF) return false;
    }
    return null;
  }

  /**
   * Request current paint state from the PLC via a viewport event.
   * This is the protocol's standard polling mechanism — the PLC responds
   * with paint commands for all visible elements.
   */
  private async pollPaintCommands(reason: string): Promise<PaintCommand[]> {
    const request = buildViewportEvent(
      this.client.getClientId(),
      config.browser.viewport.width,
      config.browser.viewport.height,
      1.0,
      this.client.getSessionId()
    );

    const { paintData, allCommands } = await this.client.sendEventAndCollect(request);

    if (allCommands.length === 0) {
      this.consecutiveEmptyRenders++;
      if (this.consecutiveEmptyRenders >= ProtocolController.RECONNECT_EMPTY_THRESHOLD) {
        const cooldownElapsed = (Date.now() - this.lastReconnectAt) >= ProtocolController.RECONNECT_COOLDOWN_MS;
        if (cooldownElapsed) {
          await this.doReconnect('consecutive-empty-renders');
        }
      }
    } else {
      this.consecutiveEmptyRenders = 0;
    }

    return allCommands;
  }

  private static readonly NAPIT_REQUIRED_LABELS = [
    'ohjaus',
    'tallenna asetukset',
    'lue asetukset',
    '1. painallus',
    '2. painallus',
  ];

  private isNapitTabLoaded(commands: PaintCommand[]): boolean {
    const lampCount = extractDrawImages(commands)
      .filter(img => this.isLampStatusImageId(img.imageId))
      .length;
    if (lampCount < 3) return false;

    const labels = extractTextLabels(commands);
    const normalizedTexts = new Set(labels.map(l => this.normalizeVisuText(l.text)));
    return ProtocolController.NAPIT_REQUIRED_LABELS.every(req => normalizedTexts.has(this.normalizeVisuText(req)));
  }

  /**
   * Detect if the dropdown is likely closed by checking for the "Ohjaus"
   * button label. This label is only visible when the dropdown is closed —
   * the open dropdown list covers it completely.
   */
  private isDropdownLikelyClosed(commands: PaintCommand[]): boolean {
    const labels = extractTextLabels(commands);
    return labels.some(l => this.normalizeVisuText(l.text) === 'ohjaus');
  }

  private isDropdownDefinitivelyClosed(commands: PaintCommand[]): boolean {
    return this.isDropdownLikelyClosed(commands) && !this.isDropdownOpen(commands);
  }

  private didPressLeaveDropdownOpen(downCommands: PaintCommand[], settledCommands: PaintCommand[]): boolean {
    if (this.isDropdownOpen(settledCommands)) {
      return true;
    }
    if (this.isDropdownDefinitivelyClosed(settledCommands)) {
      return false;
    }
    // Some PLC cycles render only on mouseDown and emit no mouseUp/poll deltas.
    // In that case treat a mouseDown-open snapshot as open unless a later close
    // signal appears.
    return this.isDropdownOpen(downCommands);
  }

  private async ensureDropdownClosed(reason: string): Promise<void> {
    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;

    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const probe = await this.pollPaintCommands(`dropdown-close-probe:${reason}:${attempt}`);
      if (!this.isDropdownOpen(probe)) {
        return;
      }

      logger.warn({ reason, attempt }, 'Dropdown state not definitively closed; toggling arrow to restore baseline');
      const { upCommands } = await this.client.pressAndCollectDetailed(arrowX, arrowY);
      const settle = [...upCommands];
      if (!this.isDropdownOpen(settle)) {
        return;
      }

      const deadline = Date.now() + 1800;
      let poll = 0;
      while (Date.now() < deadline) {
        poll++;
        const cmds = await this.pollPaintCommands(`dropdown-close-wait:${reason}:${attempt}:${poll}`);
        settle.push(...cmds);
        if (!this.isDropdownOpen(cmds) || !this.isDropdownOpen(settle)) {
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await this.delay(Math.min(120, remaining));
        }
      }
    }

    throw new Error(`Dropdown failed to reach closed state: ${reason}`);
  }

  private async forceDropdownResync(reason: string): Promise<void> {
    try {
      await this.ensureDropdownClosed(`resync:${reason}`);
      logger.warn({ reason }, 'Forced dropdown baseline resync after repeated mismatch');
    } catch (error) {
      logger.warn({ error, reason }, 'Dropdown resync attempt failed');
    }
  }

  /**
   * Reopen the dropdown from a known-closed state. Clicks the dropdown
   * arrow once to open, waits for 5 labels, and syncs scroll state.
   * Returns the accumulated commands and resolved snapshot.
   */
  private async reopenDropdownFromClosed(reason: string): Promise<{
    commands: PaintCommand[];
    snapshot: ReturnType<ProtocolController['resolveDropdownSnapshot']>;
  }> {
    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const arrowY = uiCoordinates.lightSwitches.dropdownArrow.y;
    await this.ensureDropdownClosed(`reopen:${reason}`);
    const accum: PaintCommand[] = [];

    const { downCommands, upCommands } = await this.client.pressAndCollectDetailed(arrowX, arrowY);
    accum.push(...downCommands, ...upCommands);
    const settled = [...upCommands];

    if (!this.didPressLeaveDropdownOpen(downCommands, settled)) {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const cmds = await this.pollPaintCommands(`reopen-wait:${reason}`);
        settled.push(...cmds);
        accum.push(...cmds);
        if (this.didPressLeaveDropdownOpen(downCommands, settled)) break;
        const remaining = deadline - Date.now();
        if (remaining > 0) await this.delay(Math.min(150, remaining));
      }
    }

    const snapshot = this.resolveDropdownSnapshot(accum);
    if (snapshot) {
      this.dropdownFirstVisible = snapshot.firstVisible;
      this.dropdownHandleCenterY = snapshot.handleCenterY;
      logger.info({ reason, firstVisible: snapshot.firstVisible }, 'Dropdown reopened and synced');
    } else {
      logger.warn({ reason }, 'Dropdown reopen produced no snapshot');
    }

    return { commands: accum, snapshot };
  }

  private isDropdownOpen(commands: PaintCommand[]): boolean {
    const dropdown = uiCoordinates.lightSwitches.dropdownList;
    const arrowX = uiCoordinates.lightSwitches.dropdownArrow.x;
    const listTop = dropdown.firstItemY;
    const listBottom = dropdown.firstItemY + (dropdown.itemHeight * dropdown.visibleItems);
    const listLeft = Math.max(0, dropdown.itemX - 260);
    const listRight = arrowX + 8;

    const labels = extractTextLabels(commands);
    const dropdownLabels = labels
      .filter(l => l.top >= listTop && l.bottom <= listBottom)
      .filter(l => l.right >= listLeft && l.left <= listRight)
      .filter(l => this.resolveLightIndexFromLabel(l.text) !== null);

    if (this.resolveDropdownSnapshot(commands)) {
      return true;
    }

    // In unstable sessions one row label may be temporarily missing; 3+ labels
    // in the list area is enough to treat the dropdown as open.
    return dropdownLabels.length >= 3;
  }

  private async navigateToNapitTab(): Promise<void> {
    const coords = uiCoordinates.tabs.napit;
    const timeoutMs = config.protocol?.initialRenderTimeoutMs ?? ProtocolController.DEFAULT_INITIAL_RENDER_TIMEOUT_MS;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info({ attempt }, `Clicking Napit tab at (${coords.x}, ${coords.y})`);
      const accumulated: PaintCommand[] = [];

      const clickCommands = await this.client.pressAndCollect(coords.x, coords.y);
      accumulated.push(...clickCommands);

      if (this.isNapitTabLoaded(accumulated)) {
        logger.info({ attempt, commandCount: accumulated.length }, 'Napit tab loaded after click');
        return;
      }

      // Poll with forceRender until the tab content arrives or timeout.
      const deadline = Date.now() + timeoutMs;
      let poll = 0;
      while (Date.now() < deadline) {
        poll++;
        const cmds = await this.pollPaintCommands(`napit-verify:${attempt}:${poll}`);
        accumulated.push(...cmds);
        if (this.isNapitTabLoaded(accumulated)) {
          logger.info({ attempt, poll, commandCount: accumulated.length }, 'Napit tab loaded after polling');
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await this.delay(Math.min(200, remaining));
        }
      }

      logger.warn({ attempt, commandCount: accumulated.length }, 'Napit tab not verified within timeout');
    }

    throw new Error(`Napit tab navigation failed after ${maxAttempts} attempts`);
  }

  private async doReconnect(reason: string): Promise<void> {
    logger.warn({ reason }, 'Reconnecting to PLC...');
    try {
      await this.client.disconnect();
    } catch (error) {
      logger.warn({ error }, 'Error during disconnect before reconnect');
    }

    // Reset controller state
    this.dropdownFirstVisible = 0;
    this.dropdownHandleCenterY = uiCoordinates.lightSwitches.scrollbar.thumbRange.topY;


    this.lastStatusByLight.clear();
    this.consecutiveEmptyRenders = 0;
    this.lastReconnectAt = Date.now();

    await this.client.connect();
    await this.waitForInitialRenderReady();
    await this.navigateToNapitTab();

    logger.info({ reason }, 'Reconnected successfully');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
