// Stateful CoDeSys WebVisu protocol client

import fs from 'fs';
import https from 'https';
import path from 'path';
import { constants, createHash, createPublicKey, publicEncrypt } from 'crypto';
import {
  buildOpenConnection,
  parseOpenConnectionResponse,
  buildGetMyIP,
  buildBenchmark,
  parseGetMyIPResponse,
  buildDeviceSession,
  parseDeviceSessionResponse,
  buildDeviceCryptChallenge,
  parseDeviceCryptChallengeResponse,
  buildDeviceLoginChallenge,
  buildDeviceLogin,
  parseDeviceLoginResponse,
  buildRegisterClient,
  parseRegisterClientResponse,
  buildIsRegisteredClient,
  parseIsRegisteredResponse,
  buildRemoveClient,
  buildViewportEvent,
  buildCapabilitiesEvent,
  buildStartVisuEvent,
  buildHeartbeat,
  buildMouseMove,
  buildMouseDown,
  buildMouseUp,
  buildContinuation,
  parsePaintDataResponse,
  PaintDataResponse,
} from './messages';
import { extractDrawImages, extractTextLabels, parsePaintCommands, PaintCommand } from './paint-commands';
import { BinaryReader, findTlvEntry, parseFrame, readTlvEntries } from './binary';
import { getPaintCommandReferenceName } from './command-registry';
import pino from 'pino';

const logger = pino({ name: 'protocol-client' });

interface DecodedCommandMeta {
  commandType: string;
  requestType?: number;
  requestTypeName?: string;
  serviceGroup?: number;
  serviceId?: number;
  sessionId?: number;
  headerLength?: number;
  contentLength?: number;
  serviceName?: string;
}

export interface ProtocolPaintRequestEvent {
  eventTag: number;
  eventName: string;
  param1: number;
  param2: number;
  x: number;
  y: number;
  clientId: number;
  packedCoordinates: boolean;
  hasExtraData: boolean;
  extraDataLength: number;
  hasClipRect: boolean;
  hasScaleInfo: boolean;
}

export interface ProtocolPaintFrame {
  capturedAt: string;
  capturedAtMs: number;
  responseDurationMs: number;
  httpStatus: number;
  requestType?: number;
  requestTypeName?: string;
  serviceGroup?: number;
  serviceId?: number;
  serviceName?: string;
  requestEvent?: ProtocolPaintRequestEvent;
  paint: {
    error: number;
    commandCount: number;
    continuation: number;
  };
  commands: PaintCommand[];
}

export interface RenderSettleOptions {
  reason?: string;
  minEmptyPolls?: number;
  maxPolls?: number;
  pollIntervalMs?: number;
  hashStreak?: number;
  timeoutMs?: number;
}

export interface RenderSettleResult {
  commands: PaintCommand[];
  polls: number;
  emptyStreak: number;
  hashStreak: number;
  settledBy: 'empty-streak' | 'hash-streak' | 'max-polls' | 'timeout';
  durationMs: number;
}

export interface ProtocolConfig {
  host: string;
  port: number;
  initialServiceSessionId: number;
  plcAddress: string;
  commBufferSize: number;
  useLocalHost: boolean;
  application: string;
  startVisu: string;
  deviceSessionClientName: string;
  deviceSessionClientVersion: string;
  deviceSessionFlags: number;
  viewportWidth: number;
  viewportHeight: number;
  requestTimeout: number;
  reconnectDelay: number;
  postClickDelay: number;
  postSelectDelay: number;
  registrationPollInterval: number;
  registrationMaxAttempts: number;
  tlsCaFile?: string;
  tlsRejectUnauthorized?: boolean;
  debugHttp?: boolean;
  referer?: string;
  preflightConfig?: boolean;
  preflightConfigPath?: string;
  applyServerConfig?: boolean;
  postDataInHeader?: 'auto' | 'always' | 'never';
  postDataHeaderThreshold?: number;
  postMethodDeriveMarginMs?: number;
  deviceUsername?: string;
  devicePassword?: string;
  sessionTraceEnabled?: boolean;
  sessionTraceDir?: string;
  logRawFrameData?: boolean;
  strictPaintValidation?: boolean;
  renderSettleMinEmptyPolls?: number;
  renderSettleMaxPolls?: number;
  renderSettlePollIntervalMs?: number;
  renderSettleHashStreak?: number;
  renderSettleTimeoutMs?: number;
  onPaintFrame?: (frame: ProtocolPaintFrame) => void;
}

export const defaultProtocolConfig: ProtocolConfig = {
  host: '192.168.1.10',
  port: 443,
  initialServiceSessionId: 0xABCD,
  plcAddress: '0370.1000.2DDC.C0A8.010A',
  commBufferSize: 50000,
  useLocalHost: true,
  application: 'Application',
  startVisu: 'Visualization',
  deviceSessionClientName: 'WebVisualization',
  deviceSessionClientVersion: '3.5.17.0',
  deviceSessionFlags: 3,
  viewportWidth: 1280,
  viewportHeight: 1024,
  requestTimeout: 5000,
  reconnectDelay: 5000,
  postClickDelay: 0,
  postSelectDelay: 100,
  registrationPollInterval: 100,
  registrationMaxAttempts: 50,
  tlsRejectUnauthorized: false,
  debugHttp: false,
  referer: 'https://192.168.1.10/webvisu/webvisu.htm',
  preflightConfig: true,
  preflightConfigPath: '/webvisu/webvisu.cfg.json',
  applyServerConfig: true,
  postDataInHeader: 'auto',
  postDataHeaderThreshold: 70,
  postMethodDeriveMarginMs: 20,
  deviceUsername: '',
  devicePassword: '',
  sessionTraceEnabled: false,
  sessionTraceDir: path.resolve(process.cwd(), 'data', 'protocol-trace'),
  logRawFrameData: false,
  strictPaintValidation: true,
  renderSettleMinEmptyPolls: 2,
  renderSettleMaxPolls: 8,
  renderSettlePollIntervalMs: 80,
  renderSettleHashStreak: 0,
  renderSettleTimeoutMs: 0,
};

export class WebVisuProtocolClient {
  private openConnectionSessionId: number = 0;
  private sessionId: number = defaultProtocolConfig.initialServiceSessionId;
  private clientId: number = 0;
  private clientIp: string = '127.0.0.1';
  private connected: boolean = false;
  private lastMouseX: number = -1;
  private lastMouseY: number = -1;
  private config: ProtocolConfig;
  private agent: https.Agent;
  private sendShortPayloadInHeader: boolean = false;
  private cookies: Map<string, string> = new Map();
  private sessionTraceFilePath: string | null = null;
  private sessionTraceStream: fs.WriteStream | null = null;

  constructor(config: Partial<ProtocolConfig> = {}) {
    this.config = { ...defaultProtocolConfig, ...config };
    if (this.config.debugHttp) {
      logger.level = 'debug';
    }
    let ca: Buffer | undefined;
    if (this.config.tlsCaFile) {
      try {
        ca = fs.readFileSync(this.config.tlsCaFile);
      } catch (error) {
        logger.warn({ error, path: this.config.tlsCaFile }, 'Failed to read TLS CA file');
      }
    }
    this.agent = new https.Agent({
      rejectUnauthorized: this.config.tlsRejectUnauthorized ?? false,
      ca,
      keepAlive: true,
      maxSockets: 1,
    });
  }

  async connect(): Promise<void> {
    this.startSessionTrace();
    logger.info('Starting protocol handshake...');
    if (this.config.preflightConfig) {
      await this.fetchServerConfig();
    }

    // Step 3: OpenConnection
    logger.info('Step 3: OpenConnection');
    const openRequest = buildOpenConnection(
      this.config.plcAddress,
      this.config.commBufferSize,
      this.config.useLocalHost
    );
    const openMaxAttempts = 4;
    let openResp: ArrayBuffer | null = null;
    for (let attempt = 1; attempt <= openMaxAttempts; attempt++) {
      try {
        // On flaky PLC sessions OpenConnection can intermittently return HTTP 200
        // with empty payload. Retry with a short backoff instead of failing the
        // full handshake immediately.
        openResp = await this.sendRaw(openRequest);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retriable = this.isRetriableOpenConnectionError(message);
        if (!retriable || attempt >= openMaxAttempts) {
          throw error;
        }
        logger.warn({ attempt, openMaxAttempts, error: message }, 'OpenConnection failed, retrying');
        await this.delay(120 * attempt);
      }
    }
    if (!openResp) {
      throw new Error('OpenConnection failed: empty response after retries');
    }
    const connInfo = parseOpenConnectionResponse(openResp);
    this.openConnectionSessionId = connInfo.sessionId;
    logger.info(`Session established: id=${this.openConnectionSessionId}, commBuffer=${connInfo.commBufferSize}, demo=${connInfo.demoMode}, supportsPost=${connInfo.supportsPostMethod}`);

    // Step 4: GetMyIP
    logger.info('Step 4: GetMyIP');
    const ipResp = await this.sendRaw(buildGetMyIP(this.sessionId));
    this.clientIp = parseGetMyIPResponse(ipResp);
    logger.info(`Client IP: ${this.clientIp}`);

    // webvisu.js: derive whether short payloads should be moved to 3S-Repl-Content.
    await this.configurePostDataMethod(connInfo.supportsPostMethod);

    // Step 5: DeviceSession
    logger.info('Step 5: DeviceSession');
    const devResp = await this.sendRaw(buildDeviceSession(
      this.sessionId,
      this.clientIp,
      this.config.deviceSessionClientName,
      this.config.deviceSessionClientVersion,
      this.config.deviceSessionFlags
    ));
    const devSession = parseDeviceSessionResponse(devResp);
    if (devSession.error !== 0 && devSession.error !== 18) {
      throw new Error(`DeviceSession error: ${devSession.error}`);
    }
    this.sessionId = devSession.deviceSessionId;
    logger.info(`DeviceSession: id=${devSession.deviceSessionId}, cryptType=${devSession.cryptType}`);

    // webvisu.js performs a follow-up DeviceLogin step after GetSession.
    if (devSession.cryptType === 2) {
      const username = this.config.deviceUsername ?? '';
      const password = this.config.devicePassword ?? '';
      if (!username && !password) {
        logger.info('DeviceLogin cryptType=2: trying browser-default empty credentials first');
      }

      logger.info('Step 5.1: DeviceCryptChallenge');
      const cryptReq = buildDeviceCryptChallenge(this.sessionId, 2);
      logger.info({ sessionId: this.sessionId, requestHex: Buffer.from(cryptReq).toString('hex') }, 'DeviceCryptChallenge request');
      let cryptResp = await this.sendRaw(cryptReq);
      logger.info({ responseHex: Buffer.from(cryptResp).toString('hex') }, 'DeviceCryptChallenge response');
      let crypt = parseDeviceCryptChallengeResponse(cryptResp);
      if (crypt.result === 10 && !this.sendShortPayloadInHeader) {
        // Browser can be forced into header mode via CFG_PostDataInHeader.
        // Retry challenge once with header payload mode before failing.
        logger.warn('DeviceCrypt challenge returned 10 in body mode, retrying with 3S-Repl-Content');
        cryptResp = await this.sendRaw(buildDeviceCryptChallenge(this.sessionId, 2), { useHeaderPayload: true });
        logger.info({ responseHex: Buffer.from(cryptResp).toString('hex') }, 'DeviceCryptChallenge response (header mode)');
        crypt = parseDeviceCryptChallengeResponse(cryptResp);
      }
      if (!crypt.publicKeyPem || !crypt.challenge) {
        throw new Error('DeviceCrypt challenge missing public key or challenge bytes');
      }
      if (crypt.result !== 0) {
        // webvisu.js continues with challenge login as long as key/challenge are present.
        logger.warn({ result: crypt.result }, 'DeviceCrypt challenge returned non-zero result, continuing with challenge login');
      }

      const encryptedPassword = this.encryptChallengePassword(password, crypt.publicKeyPem, crypt.challenge);
      logger.info('Step 5.2: DeviceLogin');
      const loginResp = await this.sendRaw(
        buildDeviceLoginChallenge(this.sessionId, username.slice(0, 60), encryptedPassword)
      );
      const login = parseDeviceLoginResponse(loginResp);
      if (login.result !== 0) {
        throw new Error(`DeviceLogin error: ${login.result}`);
      }
      if (login.deviceSessionId !== 0) {
        this.sessionId = login.deviceSessionId;
      }
      logger.info(`DeviceLogin: sessionId=${this.sessionId}`);
    } else {
      logger.info('Step 5.1: DeviceLogin');
      const loginResp = await this.sendRaw(buildDeviceLogin(this.sessionId, devSession.cryptType, ''));
      const login = parseDeviceLoginResponse(loginResp);
      if (login.result !== 0) {
        throw new Error(`DeviceLogin error: ${login.result}`);
      }
      if (login.deviceSessionId !== 0) {
        this.sessionId = login.deviceSessionId;
      }
      logger.info(`DeviceLogin: sessionId=${this.sessionId}`);
    }

    // Step 6: RegisterClient
    logger.info('Step 6: RegisterClient');
    const regResp = await this.sendRaw(
      buildRegisterClient(this.config.application, 'wago-adapter', this.clientIp, this.sessionId)
    );
    const regResult = parseRegisterClientResponse(regResp);
    if (regResult.error) {
      throw new Error(`RegisterClient error: ${regResult.error}`);
    }
    this.clientId = regResult.clientId;
    logger.info(`Registered client: id=${this.clientId}`);

    // Step 7: Wait for registration
    logger.info('Step 7: IsRegisteredClient');
    for (let i = 0; i < this.config.registrationMaxAttempts; i++) {
      const checkResp = await this.sendRaw(
        buildIsRegisteredClient(this.clientId, this.sessionId)
      );
      const checkResult = parseIsRegisteredResponse(checkResp);

      if (checkResult.status === 'registered') {
        logger.info('Client registration confirmed');
        break;
      } else if (checkResult.status === 'pending') {
        await this.delay(this.config.registrationPollInterval);
      } else {
        throw new Error(`Registration failed: status=${checkResult.status}`);
      }
    }

    // Step 8: Viewport event
    logger.info('Step 8: Viewport');
    await this.sendRaw(
      buildViewportEvent(this.clientId, this.config.viewportWidth, this.config.viewportHeight, 1.0, this.sessionId)
    );

    // Step 9: Capabilities
    logger.info('Step 9: Capabilities');
    await this.sendRaw(
      buildCapabilitiesEvent(this.clientId, this.sessionId)
    );

    // Step 10: StartVisu
    logger.info('Step 10: StartVisu');
    await this.sendRaw(
      buildStartVisuEvent(this.clientId, this.config.startVisu, this.sessionId)
    );

    this.connected = true;
    logger.info('Protocol handshake complete');
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      this.stopSessionTrace();
      return;
    }

    try {
      await this.sendRaw(buildRemoveClient(this.clientId, this.sessionId));
      logger.info('Client removed');
    } catch (error) {
      logger.warn({ error }, 'Error during disconnect');
    }

    this.connected = false;
    this.openConnectionSessionId = 0;
    this.sessionId = this.config.initialServiceSessionId;
    this.clientId = 0;
    this.lastMouseX = -1;
    this.lastMouseY = -1;
    this.stopSessionTrace();
  }

  async heartbeat(): Promise<PaintDataResponse> {
    this.ensureConnected();
    const resp = await this.sendRaw(buildHeartbeat(this.clientId, this.sessionId));
    return this.handlePaintResponse(resp);
  }

  /**
   * Send a heartbeat and collect all paint commands including continuations.
   * Lightweight alternative to sending a viewport event — retrieves pending
   * paint data without triggering a full PLC redraw.
   */
  async heartbeatAndCollect(): Promise<PaintCommand[]> {
    this.ensureConnected();
    const { allCommands } = await this.sendEventAndCollect(
      buildHeartbeat(this.clientId, this.sessionId)
    );
    return allCommands;
  }

  async click(x: number, y: number): Promise<PaintDataResponse> {
    this.ensureConnected();

    // Skip mouseMove if already at the target position (saves ~1s HTTP round-trip).
    if (x !== this.lastMouseX || y !== this.lastMouseY) {
      await this.mouseMove(x, y);
    }

    // MouseDown
    await this.sendEventAndCollect(buildMouseDown(this.clientId, x, y, this.sessionId));

    // Brief delay between down and up
    await this.delay(this.config.postClickDelay);

    // MouseUp
    const { paintData } = await this.sendEventAndCollect(
      buildMouseUp(this.clientId, x, y, this.sessionId)
    );
    return paintData;
  }

  /**
   * Click at (x, y) and collect all paint commands including continuations.
   * mouseDown is sent immediately (fire-and-forget) to preserve the original timing.
   * mouseUp response is followed through all continuations.
   * Returns all paint commands collected.
   */
  async clickAndCollect(x: number, y: number): Promise<PaintCommand[]> {
    this.ensureConnected();

    // Skip mouseMove if already at the target position.
    if (x !== this.lastMouseX || y !== this.lastMouseY) {
      await this.mouseMove(x, y);
    }

    // MouseDown — fire and forget; preserves original timing so the PLC processes
    // mouseDown+mouseUp as a complete gesture and renders on the mouseUp continuation
    await this.sendRaw(buildMouseDown(this.clientId, x, y, this.sessionId));

    await this.delay(this.config.postClickDelay);

    // MouseUp — collect with continuations; the PLC renders the click result here
    const { allCommands } = await this.sendEventAndCollect(
      buildMouseUp(this.clientId, x, y, this.sessionId)
    );
    return allCommands;
  }

  /**
   * Press mouseDown and collect its response, then send mouseUp and collect its response.
   * Use when the control renders on mouseDown (e.g. dropdown arrow opening the list).
   * Returns combined commands from both events.
   */
  async pressAndCollect(x: number, y: number): Promise<PaintCommand[]> {
    const detailed = await this.pressAndCollectDetailed(x, y);
    return [...detailed.downCommands, ...detailed.upCommands];
  }

  /**
   * Press mouseDown and mouseUp while returning the command streams separately.
   * Needed when caller must reason about final state after mouseUp without mixing
   * transient mouseDown-only render output.
   */
  async pressAndCollectDetailed(x: number, y: number): Promise<{ downCommands: PaintCommand[]; upCommands: PaintCommand[] }> {
    this.ensureConnected();

    // Skip mouseMove if already at the target position.
    if (x !== this.lastMouseX || y !== this.lastMouseY) {
      await this.mouseMove(x, y);
    }

    // MouseDown — collect; dropdown lists render when the button is pressed
    const { allCommands: downCommands } = await this.sendEventAndCollect(
      buildMouseDown(this.clientId, x, y, this.sessionId)
    );

    await this.delay(this.config.postClickDelay);

    // MouseUp — collect; may have additional commands
    const { allCommands: upCommands } = await this.sendEventAndCollect(
      buildMouseUp(this.clientId, x, y, this.sessionId)
    );
    return { downCommands, upCommands };
  }

  /**
   * Send a mouseDown at (x, y) and collect all paint commands including continuations.
   * Used when mouseDown triggers a UI change (e.g. dropdown item selection closes the list).
   */
  async mouseDownAndCollect(x: number, y: number): Promise<PaintCommand[]> {
    this.ensureConnected();
    if (x !== this.lastMouseX || y !== this.lastMouseY) {
      await this.mouseMove(x, y);
    }
    const { allCommands } = await this.sendEventAndCollect(
      buildMouseDown(this.clientId, x, y, this.sessionId)
    );
    return allCommands;
  }

  /**
   * Send a mouseUp at (x, y) and collect all paint commands including continuations.
   * Used by doDrag to capture the scroll result from the final mouseUp.
   */
  async mouseUpAndCollect(x: number, y: number): Promise<PaintCommand[]> {
    this.ensureConnected();
    const { allCommands } = await this.sendEventAndCollect(
      buildMouseUp(this.clientId, x, y, this.sessionId)
    );
    return allCommands;
  }

  async mouseMove(x: number, y: number): Promise<PaintDataResponse> {
    this.ensureConnected();
    const { paintData } = await this.sendEventAndCollect(
      buildMouseMove(this.clientId, x, y, this.sessionId)
    );
    this.lastMouseX = x;
    this.lastMouseY = y;
    return paintData;
  }

  /**
   * Send a mouseMove at (x, y) and collect all paint commands including continuations.
   * Used for the final drag step to capture scroll state rendered at the destination position.
   */
  async mouseMoveAndCollect(x: number, y: number): Promise<PaintCommand[]> {
    this.ensureConnected();
    const { allCommands } = await this.sendEventAndCollect(
      buildMouseMove(this.clientId, x, y, this.sessionId)
    );
    this.lastMouseX = x;
    this.lastMouseY = y;
    return allCommands;
  }

  async mouseDown(x: number, y: number): Promise<PaintDataResponse> {
    this.ensureConnected();
    const { paintData } = await this.sendEventAndCollect(
      buildMouseDown(this.clientId, x, y, this.sessionId)
    );
    return paintData;
  }

  async mouseUp(x: number, y: number): Promise<PaintDataResponse> {
    this.ensureConnected();
    const { paintData } = await this.sendEventAndCollect(
      buildMouseUp(this.clientId, x, y, this.sessionId)
    );
    return paintData;
  }

  /**
   * Send an event and collect full paint response including continuations.
   * Returns all paint commands collected from all continuation responses.
   */
  async sendEventAndCollect(requestBuf: ArrayBuffer): Promise<{ paintData: PaintDataResponse; allCommands: PaintCommand[] }> {
    this.ensureConnected();
    const resp = await this.sendRaw(requestBuf);
    let paintData = this.handlePaintResponse(resp);
    const allCommandData: Uint8Array[] = [paintData.commands];
    let declaredCommandCount = paintData.commandCount;
    let responseCount = 1;

    // Handle continuations
    while (paintData.continuation > 0) {
      const contResp = await this.sendRaw(
        buildContinuation(paintData.continuation, this.sessionId)
      );
      paintData = this.handlePaintResponse(contResp);
      allCommandData.push(paintData.commands);
      declaredCommandCount += paintData.commandCount;
      responseCount++;
    }

    // Concatenate all command data
    const totalLen = allCommandData.reduce((sum, d) => sum + d.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of allCommandData) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const allCommands = parsePaintCommands(combined);
    this.validateCollectedPaintCommands(combined, allCommands, declaredCommandCount, responseCount);
    return { paintData, allCommands };
  }

  async waitForRenderSettled(options: RenderSettleOptions = {}): Promise<RenderSettleResult> {
    this.ensureConnected();

    const reason = options.reason ?? 'unspecified';
    const minEmptyPolls = Math.max(1, options.minEmptyPolls ?? this.config.renderSettleMinEmptyPolls ?? 2);
    const maxPolls = Math.max(minEmptyPolls, options.maxPolls ?? this.config.renderSettleMaxPolls ?? 8);
    const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? this.config.renderSettlePollIntervalMs ?? 80);
    const hashTarget = Math.max(0, options.hashStreak ?? this.config.renderSettleHashStreak ?? 0);
    const timeoutMs = Math.max(0, options.timeoutMs ?? this.config.renderSettleTimeoutMs ?? 0);
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

    const commands: PaintCommand[] = [];
    let polls = 0;
    let emptyStreak = 0;
    let hashStreak = 0;
    let settledBy: RenderSettleResult['settledBy'] = 'max-polls';
    let previousHash: string | null = null;
    const startedAt = Date.now();

    while (polls < maxPolls && Date.now() <= deadline) {
      polls++;
      const polledCommands = await this.heartbeatAndCollect();
      commands.push(...polledCommands);

      if (polledCommands.length === 0) {
        emptyStreak++;
        hashStreak = 0;
        previousHash = null;
      } else {
        emptyStreak = 0;
        if (hashTarget > 0) {
          const hash = this.hashCommandStream(polledCommands);
          hashStreak = previousHash === hash ? hashStreak + 1 : 1;
          previousHash = hash;
        }
      }

      if (emptyStreak >= minEmptyPolls) {
        settledBy = 'empty-streak';
        break;
      }
      if (hashTarget > 0 && hashStreak >= hashTarget) {
        settledBy = 'hash-streak';
        break;
      }

      if (polls < maxPolls) {
        const remaining = deadline - Date.now();
        if (remaining > 0 && pollIntervalMs > 0) {
          await this.delay(Math.min(pollIntervalMs, remaining));
        }
      }
    }

    if (Date.now() > deadline && settledBy !== 'empty-streak' && settledBy !== 'hash-streak') {
      settledBy = 'timeout';
    }

    const result: RenderSettleResult = {
      commands,
      polls,
      emptyStreak,
      hashStreak,
      settledBy,
      durationMs: Date.now() - startedAt,
    };

    const logPayload = {
      reason,
      polls: result.polls,
      emptyStreak: result.emptyStreak,
      hashStreak: result.hashStreak,
      settledBy: result.settledBy,
      durationMs: result.durationMs,
      commandCount: commands.length,
      minEmptyPolls,
      maxPolls,
      timeoutMs,
      hashTarget,
    };

    if (settledBy === 'empty-streak' || settledBy === 'hash-streak') {
      logger.debug(logPayload, 'Render settle converged');
    } else {
      logger.warn(logPayload, 'Render settle did not converge before limits');
    }

    return result;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getClientId(): number {
    return this.clientId;
  }

  getSessionId(): number {
    return this.sessionId;
  }

  getOpenConnectionSessionId(): number {
    return this.openConnectionSessionId;
  }

  private handlePaintResponse(buf: ArrayBuffer): PaintDataResponse {
    try {
      return parsePaintDataResponse(buf);
    } catch (error) {
      logger.error({ error }, 'Failed to parse paint response');
      throw error;
    }
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('Protocol client not connected. Call connect() first.');
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private toArrayBuffer(buf: Buffer): ArrayBuffer {
    const out = new ArrayBuffer(buf.byteLength);
    new Uint8Array(out).set(buf);
    return out;
  }

  private toLatin1Text(buf: Buffer): string {
    return buf.toString('latin1').replace(/\x00+$/g, '');
  }

  private hashCommandStream(commands: PaintCommand[]): string {
    const hash = createHash('sha1');
    const header = Buffer.allocUnsafe(8);
    for (const cmd of commands) {
      header.writeUInt32LE(cmd.size >>> 0, 0);
      header.writeUInt32LE(cmd.id >>> 0, 4);
      hash.update(header);
      hash.update(cmd.data);
    }
    return hash.digest('hex');
  }

  private validateCollectedPaintCommands(
    rawData: Uint8Array,
    commands: PaintCommand[],
    declaredCommandCount: number,
    responseCount: number,
  ): void {
    const integrity = this.inspectCommandStream(rawData);
    const countMismatch = declaredCommandCount > 0 && commands.length !== declaredCommandCount;
    const hasStructuralIssue = integrity.invalidOffset !== null || integrity.trailingBytes > 0;

    if (!countMismatch && !hasStructuralIssue) {
      return;
    }

    const details = {
      declaredCommandCount,
      parsedCommandCount: commands.length,
      responseCount,
      rawByteLength: rawData.length,
      trailingBytes: integrity.trailingBytes,
      invalidOffset: integrity.invalidOffset,
      invalidReason: integrity.invalidReason ?? undefined,
    };

    if (countMismatch) {
      logger.warn(details, 'Paint command count mismatch between headers and parsed stream');
    }

    if (hasStructuralIssue) {
      const message = 'Paint command stream ended with invalid or truncated payload';
      if (this.config.strictPaintValidation === false) {
        logger.warn(details, message);
      } else {
        throw new Error(`${message}: ${JSON.stringify(details)}`);
      }
    }
  }

  private inspectCommandStream(data: Uint8Array): {
    trailingBytes: number;
    invalidOffset: number | null;
    invalidReason: 'size-too-small' | 'truncated-command' | null;
  } {
    if (data.length === 0) {
      return { trailingBytes: 0, invalidOffset: null, invalidReason: null };
    }

    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;

    while ((offset + 8) <= data.length) {
      const size = dv.getUint32(offset, true);
      if (size < 8) {
        return {
          trailingBytes: data.length - offset,
          invalidOffset: offset,
          invalidReason: 'size-too-small',
        };
      }

      if ((offset + size) > data.length) {
        return {
          trailingBytes: data.length - offset,
          invalidOffset: offset,
          invalidReason: 'truncated-command',
        };
      }

      offset += size;
    }

    const trailingBytes = data.length - offset;
    return {
      trailingBytes,
      invalidOffset: trailingBytes > 0 ? offset : null,
      invalidReason: trailingBytes > 0 ? 'truncated-command' : null,
    };
  }

  private getPaintCommandName(commandId: number): string {
    const map: Record<number, string> = {
      0: 'NoOpPaintCommand',
      24: 'SetCursorStyle',
      47: 'DrawTextUtf16',
      48: 'AreaGradientStyle',
      73: 'SetCornerRadius',
    };
    return map[commandId] ?? getPaintCommandReferenceName(commandId) ?? 'Cmd';
  }

  private getPaintEventName(eventTag: number): string {
    const map: Record<number, string> = {
      1: 'Heartbeat',
      2: 'MouseDown',
      8: 'MouseClick',
      4: 'MouseUp',
      16: 'MouseMove',
      32: 'MouseDblClick',
      64: 'MouseWheel',
      128: 'KeyDown',
      256: 'KeyUp',
      257: 'KeyPress',
      2048: 'MouseEnter',
      516: 'ViewportInfo',
      4096: 'MouseOut',
      1048576: 'Control',
    };
    return map[eventTag] ?? `Event(${eventTag})`;
  }

  private decodeGetPaintRequestEvent(serviceFrameBuf: ArrayBuffer): ProtocolPaintRequestEvent | null {
    try {
      const frame = parseFrame(serviceFrameBuf);
      const entries = readTlvEntries(new BinaryReader(frame.content), frame.content.length);
      const container = findTlvEntry(entries, 132) || findTlvEntry(entries, 129);
      if (!container) return null;

      const innerEntries = readTlvEntries(new BinaryReader(container.data), container.data.length);
      const header = findTlvEntry(innerEntries, 1);
      if (!header || header.data.length < 16) return null;

      const dv = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
      const eventTag = dv.getUint32(0, true);
      const param1 = dv.getUint32(4, true);
      const param2 = dv.getUint32(8, true);
      const clientId = dv.getUint32(12, true);
      const extra = findTlvEntry(innerEntries, 2);
      const clip = findTlvEntry(innerEntries, 3);
      const scale = findTlvEntry(innerEntries, 5);
      const packedCoordinates = eventTag === 2 || eventTag === 4 || eventTag === 8 || eventTag === 16 || eventTag === 32;
      const x = packedCoordinates ? ((param1 >>> 16) & 0xffff) : param1;
      const y = packedCoordinates ? (param1 & 0xffff) : param2;

      return {
        eventTag,
        eventName: this.getPaintEventName(eventTag),
        param1,
        param2,
        x,
        y,
        clientId,
        packedCoordinates,
        hasExtraData: !!extra,
        extraDataLength: extra?.data.length ?? 0,
        hasClipRect: !!clip,
        hasScaleInfo: !!scale,
      };
    } catch {
      return null;
    }
  }

  private summarizePaintCommands(commands: PaintCommand[]): string {
    if (commands.length === 0) return 'none';
    return commands
      .map((cmd) => `${this.getPaintCommandName(cmd.id)}(${cmd.id})`)
      .join(', ');
  }

  private toLatin1Bytes(value: string): Uint8Array {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      bytes[i] = value.charCodeAt(i) & 0xFF;
    }
    return bytes;
  }

  private normalizePublicKeyPem(publicKeyPem: string): string {
    if (publicKeyPem.includes('BEGIN PUBLIC KEY')) {
      return publicKeyPem;
    }
    const normalized = publicKeyPem.replace(/\s+/g, '');
    const lines = normalized.match(/.{1,64}/g) ?? [];
    return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
  }

  private encryptChallengePassword(password: string, publicKeyPem: string, challenge: Uint8Array): Uint8Array {
    const plain = new Uint8Array(60);
    const passwordBytes = this.toLatin1Bytes(password);
    const copyLen = Math.min(passwordBytes.length, 60);
    for (let i = 0; i < copyLen; i++) {
      plain[i] = passwordBytes[i];
    }

    const xorLen = Math.min(challenge.length, 60);
    for (let i = 0; i < xorLen; i++) {
      plain[i] ^= challenge[i];
    }

    const key = createPublicKey(this.normalizePublicKeyPem(publicKeyPem));
    const encrypted = publicEncrypt({
      key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, Buffer.from(plain));
    return new Uint8Array(encrypted);
  }

  private formatTraceTimestamp(date: Date = new Date()): string {
    const yyyy = date.getFullYear().toString().padStart(4, '0');
    const mm = (date.getMonth() + 1).toString().padStart(2, '0');
    const dd = date.getDate().toString().padStart(2, '0');
    const hh = date.getHours().toString().padStart(2, '0');
    const mi = date.getMinutes().toString().padStart(2, '0');
    const ss = date.getSeconds().toString().padStart(2, '0');
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return `${yyyy}${mm}${dd}-${hh}${mi}${ss}-${ms}`;
  }

  private startSessionTrace(): void {
    if (!this.config.sessionTraceEnabled) {
      return;
    }
    this.stopSessionTrace();

    try {
      const traceDir = this.config.sessionTraceDir ?? path.resolve(process.cwd(), 'data', 'protocol-trace');
      fs.mkdirSync(traceDir, { recursive: true });
      const stamp = this.formatTraceTimestamp();
      const filename = `protocol-session-${stamp}.log`;
      const filePath = path.join(traceDir, filename);
      this.sessionTraceStream = fs.createWriteStream(filePath, { flags: 'a' });
      this.sessionTraceFilePath = filePath;
      logger.info({ file: filePath }, 'Protocol session trace file created');
      this.writeTraceEntry({
        event: 'session-start',
        host: this.config.host,
        port: this.config.port,
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to create protocol session trace file');
      this.sessionTraceStream = null;
      this.sessionTraceFilePath = null;
    }
  }

  private stopSessionTrace(): void {
    if (!this.sessionTraceStream) {
      this.sessionTraceFilePath = null;
      return;
    }
    try {
      this.writeTraceEntry({
        event: 'session-end',
        connected: this.connected,
      });
      this.sessionTraceStream.end();
    } catch {
      // Ignore stream close errors in cleanup path.
    }
    this.sessionTraceStream = null;
    this.sessionTraceFilePath = null;
  }

  private writeTraceEntry(entry: Record<string, unknown>): void {
    if (!this.sessionTraceStream) return;
    const record = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    try {
      this.sessionTraceStream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Ignore write failures to avoid impacting protocol flow.
    }
  }

  private getRequestTypeName(type: number): string {
    const map: Record<number, string> = {
      1: 'OpenConnection',
      2: 'ServiceRequest',
      3: 'GetMyIP',
      100: 'Benchmark',
    };
    return map[type] ?? `Type${type}`;
  }

  private normalizeServiceGroup(group: number): number {
    // Response frames set the high response bit (0x80) on the group value.
    return group & 0x7F;
  }

  private getServiceName(group: number, id: number): string {
    const key = `${this.normalizeServiceGroup(group)}:${id}`;
    const map: Record<string, string> = {
      '1:2': 'DeviceAuth',
      '1:10': 'DeviceSession',
      '4:1': 'RegisterClient',
      '4:2': 'RemoveClient',
      '4:3': 'IsRegisteredClient',
      '4:4': 'GetPaintData',
    };
    return map[key] ?? `Service(${this.normalizeServiceGroup(group)},${id})`;
  }

  private decodeServiceFrame(buf: Buffer, offset: number): {
    serviceGroup: number;
    serviceId: number;
    sessionId: number;
    headerLength: number;
    contentLength: number;
    serviceName: string;
  } | null {
    if (buf.length < offset + 20) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset + offset, buf.byteLength - offset);
    const magic = dv.getUint16(0, true);
    if (magic !== 0xCD55) {
      return null;
    }
    const headerLength = dv.getUint16(2, true);
    const serviceGroup = dv.getUint16(4, true);
    const serviceId = dv.getUint16(6, true);
    const sessionId = dv.getUint32(8, true);
    const contentLength = dv.getUint32(12, true);
    return {
      serviceGroup,
      serviceId,
      sessionId,
      headerLength,
      contentLength,
      serviceName: this.getServiceName(serviceGroup, serviceId),
    };
  }

  private decodeCommandMeta(direction: 'request' | 'response', buf: Buffer): DecodedCommandMeta {
    if (buf.length === 0) {
      return { commandType: 'empty' };
    }

    if (direction === 'request') {
      const requestType = buf[0];
      const requestTypeName = this.getRequestTypeName(requestType);
      if (requestType === 2) {
        const frame = this.decodeServiceFrame(buf, 4);
        if (frame) {
          return {
            commandType: 'service-request',
            requestType,
            requestTypeName,
            ...frame,
          };
        }
      }
      return {
        commandType: 'raw-request',
        requestType,
        requestTypeName,
      };
    }

    const directFrame = this.decodeServiceFrame(buf, 0);
    if (directFrame) {
      return {
        commandType: 'service-response',
        ...directFrame,
      };
    }
    const prefixedFrame = this.decodeServiceFrame(buf, 4);
    if (prefixedFrame) {
      return {
        commandType: 'prefixed-service-response',
        ...prefixedFrame,
      };
    }
    return { commandType: 'raw-response' };
  }

  private buildPlainTextParse(
    direction: 'request' | 'response',
    buf: Buffer,
    meta: DecodedCommandMeta
  ): string | undefined {
    if (buf.length === 0) {
      return 'Empty frame';
    }

    try {
      if (direction === 'request') {
        const requestType = buf[0];
        if (requestType === 1 && buf.length > 4) {
          return `OpenConnection payload="${this.toLatin1Text(buf.subarray(4))}"`;
        }
        if (requestType === 3) {
          return 'GetMyIP request';
        }
        if (requestType === 100) {
          return 'Benchmark request';
        }
        const normalizedGroup = meta.serviceGroup !== undefined
          ? this.normalizeServiceGroup(meta.serviceGroup)
          : undefined;
        if (requestType === 2 && normalizedGroup === 4 && meta.serviceId === 4 && buf.length >= 24) {
          const event = this.decodeGetPaintRequestEvent(this.toArrayBuffer(buf.subarray(4)));
          if (event) {
            if (event.packedCoordinates) {
              return `GetPaintData request event=${event.eventName}(${event.eventTag}) x=${event.x} y=${event.y} packed=0x${event.param1.toString(16).padStart(8, '0')} clientId=${event.clientId}`;
            }
            return `GetPaintData request event=${event.eventName}(${event.eventTag}) p1=${event.param1} p2=${event.param2} clientId=${event.clientId}`;
          }
        }
        if (requestType === 2 && meta.serviceName && meta.serviceGroup !== undefined && meta.serviceId !== undefined) {
          return `Service request ${meta.serviceName} (group=${meta.serviceGroup}, id=${meta.serviceId}, session=${meta.sessionId ?? 0})`;
        }
        return undefined;
      }

      // Raw text responses in startup steps.
      const asText = this.toLatin1Text(buf);
      if (asText.startsWith('|') || asText.startsWith('IPv4:')) {
        return `Text response="${asText}"`;
      }

      const serviceFrameBuf = meta.commandType === 'prefixed-service-response'
        ? this.toArrayBuffer(buf.subarray(4))
        : this.toArrayBuffer(buf);
      const normalizedGroup = meta.serviceGroup !== undefined
        ? this.normalizeServiceGroup(meta.serviceGroup)
        : undefined;

      if (normalizedGroup === 4 && meta.serviceId === 4) {
        const paint = parsePaintDataResponse(serviceFrameBuf);
        const commands = parsePaintCommands(paint.commands);
        return `GetPaintData error=${paint.error} commandCount=${paint.commandCount} continuation=${paint.continuation} commands=[${this.summarizePaintCommands(commands)}]`;
      }

      if (normalizedGroup === 4 && meta.serviceId === 1) {
        const reg = parseRegisterClientResponse(serviceFrameBuf);
        return reg.error
          ? `RegisterClient error="${reg.error}"`
          : `RegisterClient clientId=${reg.clientId}`;
      }

      if (normalizedGroup === 4 && meta.serviceId === 3) {
        const status = parseIsRegisteredResponse(serviceFrameBuf);
        return `IsRegisteredClient status=${status.status}`;
      }

      if (normalizedGroup === 1 && meta.serviceId === 10) {
        const session = parseDeviceSessionResponse(serviceFrameBuf);
        return `DeviceSession result: sessionId=${session.deviceSessionId} cryptType=${session.cryptType} error=${session.error}`;
      }

      if (normalizedGroup === 1 && meta.serviceId === 2) {
        const challenge = parseDeviceCryptChallengeResponse(serviceFrameBuf);
        if (challenge.publicKeyPem || challenge.challenge) {
          return `DeviceCryptChallenge result=${challenge.result} token=${challenge.token} challengeBytes=${challenge.challenge?.length ?? 0} hasPublicKey=${!!challenge.publicKeyPem}`;
        }
        const login = parseDeviceLoginResponse(serviceFrameBuf);
        return `DeviceLogin result=${login.result} deviceSessionId=${login.deviceSessionId}`;
      }

      if (meta.serviceName && meta.serviceGroup !== undefined && meta.serviceId !== undefined) {
        return `Service response ${meta.serviceName} (group=${meta.serviceGroup}, id=${meta.serviceId}, session=${meta.sessionId ?? 0})`;
      }
    } catch {
      // Best-effort parse only.
    }

    return undefined;
  }

  private buildFrameDebugDetails(
    direction: 'request' | 'response',
    buf: Buffer,
    meta: DecodedCommandMeta
  ): Record<string, unknown> | undefined {
    const normalizedGroup = meta.serviceGroup !== undefined
      ? this.normalizeServiceGroup(meta.serviceGroup)
      : undefined;
    if (direction === 'request' && normalizedGroup === 4 && meta.serviceId === 4 && buf.length >= 24) {
      const requestEvent = this.decodeGetPaintRequestEvent(this.toArrayBuffer(buf.subarray(4)));
      if (requestEvent) {
        return { paintRequestEvent: requestEvent };
      }
      return undefined;
    }

    if (direction !== 'response') return undefined;
    if (meta.serviceGroup === undefined || meta.serviceId === undefined) return undefined;
    if (normalizedGroup !== 4 || meta.serviceId !== 4) return undefined;

    const serviceFrameBuf = meta.commandType === 'prefixed-service-response'
      ? this.toArrayBuffer(buf.subarray(4))
      : this.toArrayBuffer(buf);

    try {
      const paint = parsePaintDataResponse(serviceFrameBuf);
      const commands = parsePaintCommands(paint.commands);
      const images = extractDrawImages(commands);
      const labels = extractTextLabels(commands);
      return {
        paintCommands: commands.map((cmd, index) => ({
          index,
          id: cmd.id,
          name: this.getPaintCommandName(cmd.id),
          size: cmd.size,
        })),
        paintImages: images.map((image, index) => ({
          index,
          imageId: image.imageId,
          x: image.x,
          y: image.y,
          width: image.width,
          height: image.height,
          flags: image.flags,
          tintColor: image.tintColor,
        })),
        paintTextLabels: labels.map((label, index) => ({
          index,
          text: label.text,
          left: label.left,
          top: label.top,
          right: label.right,
          bottom: label.bottom,
          flags: label.flags,
        })),
      };
    } catch {
      return undefined;
    }
  }

  private extractPaintRequestEvent(buf: Buffer, meta: DecodedCommandMeta): ProtocolPaintRequestEvent | undefined {
    if (meta.requestType !== 2 || meta.serviceGroup === undefined || meta.serviceId === undefined) {
      return undefined;
    }
    const normalizedGroup = this.normalizeServiceGroup(meta.serviceGroup);
    if (normalizedGroup !== 4 || meta.serviceId !== 4 || buf.length < 24) {
      return undefined;
    }
    return this.decodeGetPaintRequestEvent(this.toArrayBuffer(buf.subarray(4))) ?? undefined;
  }

  private emitPaintFrame(
    responseBuf: Buffer,
    statusCode: number,
    startedAtMs: number,
    requestMeta: DecodedCommandMeta,
    requestEvent?: ProtocolPaintRequestEvent,
  ): void {
    if (!this.config.onPaintFrame) {
      return;
    }

    const responseMeta = this.decodeCommandMeta('response', responseBuf);
    if (responseMeta.serviceGroup === undefined || responseMeta.serviceId === undefined) {
      return;
    }
    const normalizedGroup = this.normalizeServiceGroup(responseMeta.serviceGroup);
    if (normalizedGroup !== 4 || responseMeta.serviceId !== 4) {
      return;
    }

    try {
      const serviceFrameBuf = responseMeta.commandType === 'prefixed-service-response'
        ? this.toArrayBuffer(responseBuf.subarray(4))
        : this.toArrayBuffer(responseBuf);
      const paint = parsePaintDataResponse(serviceFrameBuf);
      const commands = parsePaintCommands(paint.commands);
      const capturedAtMs = Date.now();
      this.config.onPaintFrame({
        capturedAt: new Date(capturedAtMs).toISOString(),
        capturedAtMs,
        responseDurationMs: Math.max(0, capturedAtMs - startedAtMs),
        httpStatus: statusCode,
        requestType: requestMeta.requestType,
        requestTypeName: requestMeta.requestTypeName,
        serviceGroup: requestMeta.serviceGroup,
        serviceId: requestMeta.serviceId,
        serviceName: requestMeta.serviceName,
        requestEvent,
        paint: {
          error: paint.error,
          commandCount: paint.commandCount,
          continuation: paint.continuation,
        },
        commands,
      });
    } catch (error) {
      logger.debug({ error }, 'Failed to emit paint frame to observer');
    }
  }

  private logFrame(direction: 'request' | 'response', buf: Buffer, meta: Record<string, unknown> = {}): void {
    const commandMeta = this.decodeCommandMeta(direction, buf);
    const parsedText = this.buildPlainTextParse(direction, buf, commandMeta);
    const frameDebugDetails = this.buildFrameDebugDetails(direction, buf, commandMeta);

    const payload: Record<string, unknown> = {
      direction,
      length: buf.length,
      ...commandMeta,
      ...(parsedText ? { parsedText } : {}),
      ...(frameDebugDetails ?? {}),
      ...meta,
    };
    if (this.config.logRawFrameData) {
      payload.bytesHex = buf.toString('hex');
    }

    if (this.config.debugHttp) {
      logger.debug(payload, `${direction} frame`);
    }

    this.writeTraceEntry({
      event: 'frame',
      ...payload,
    });
  }

  private async configurePostDataMethod(supportsPostMethod: boolean): Promise<void> {
    if (!supportsPostMethod) {
      this.sendShortPayloadInHeader = false;
      return;
    }

    const mode = this.config.postDataInHeader ?? 'auto';
    if (mode === 'always') {
      this.sendShortPayloadInHeader = true;
      logger.info('POST data in header enabled by configuration override');
      return;
    }
    if (mode === 'never') {
      this.sendShortPayloadInHeader = false;
      logger.info('POST data in body enforced by configuration override');
      return;
    }

    logger.info('Step 4.5: Derive POST method');
    const benchmarkReq = buildBenchmark();
    const bodyMs = await this.measureRequestMs(benchmarkReq, false);
    const headerMs = await this.measureRequestMs(benchmarkReq, true);
    const margin = this.config.postMethodDeriveMarginMs ?? 20;
    this.sendShortPayloadInHeader = headerMs < (bodyMs - margin);
    logger.info(`POST method benchmark: body=${bodyMs}ms header=${headerMs}ms useHeader=${this.sendShortPayloadInHeader}`);
  }

  private async fetchServerConfig(): Promise<void> {
    const path = this.config.preflightConfigPath ?? '/webvisu/webvisu.cfg.json';
    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {
        'Accept': '*/*',
      };
      const cookieHeader = this.getCookieHeader();
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
      }

      const req = https.request({
        hostname: this.config.host,
        port: this.config.port,
        path,
        method: 'GET',
        headers,
        agent: this.agent,
        timeout: this.config.requestTimeout,
      }, (res) => {
        this.captureCookies(res.headers['set-cookie']);
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBuf = Buffer.concat(chunks);
          if (this.config.debugHttp) {
            logger.debug({
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers,
              responseLength: responseBuf.byteLength,
            }, 'Preflight config response received');
          }
          if (this.config.applyServerConfig && responseBuf.byteLength > 0) {
            this.applyServerConfig(responseBuf);
          }
          resolve();
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Preflight request timed out'));
      });
      req.end();
    });
  }

  private applyServerConfig(buf: Buffer): void {
    try {
      const cfg = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
      if (typeof cfg.PlcAddress === 'string') this.config.plcAddress = cfg.PlcAddress;
      if (typeof cfg.CommBufferSize === 'number') this.config.commBufferSize = cfg.CommBufferSize;
      if (typeof cfg.UseLocalHost === 'boolean') this.config.useLocalHost = cfg.UseLocalHost;
      if (typeof cfg.Application === 'string') this.config.application = cfg.Application;
      if (typeof cfg.StartVisu === 'string') this.config.startVisu = cfg.StartVisu;
      if (typeof cfg.PostDataInHeader === 'number') {
        if (cfg.PostDataInHeader === 1) this.config.postDataInHeader = 'always';
        else if (cfg.PostDataInHeader === 2) this.config.postDataInHeader = 'never';
        else this.config.postDataInHeader = 'auto';
      }
      if (this.config.debugHttp) {
        logger.debug({
          PlcAddress: this.config.plcAddress,
          CommBufferSize: this.config.commBufferSize,
          UseLocalHost: this.config.useLocalHost,
          Application: this.config.application,
          StartVisu: this.config.startVisu,
          PostDataInHeader: this.config.postDataInHeader,
        }, 'Applied server config overrides');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to parse preflight config JSON');
    }
  }

  private captureCookies(setCookie: string[] | string | undefined): void {
    if (!setCookie) return;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookie of cookies) {
      const first = cookie.split(';')[0]?.trim();
      if (!first) continue;
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name) {
        this.cookies.set(name, value);
      }
    }
  }

  private getCookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  private decodeResponsePayloadHeader(rawHeader: string | string[] | undefined): Uint8Array | null {
    if (!rawHeader) {
      return null;
    }

    const headerValue = Array.isArray(rawHeader)
      ? rawHeader.find((value) => value && value.trim().length > 0)
      : rawHeader;
    if (!headerValue) {
      return null;
    }

    try {
      const decoded = Buffer.from(headerValue.trim(), 'base64');
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }

  private isRetriableOpenConnectionError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes('response length 0') ||
      normalized.includes('socket hang up') ||
      normalized.includes('econnreset') ||
      normalized.includes('timed out');
  }

  private async measureRequestMs(data: ArrayBuffer, useHeaderPayload: boolean): Promise<number> {
    const start = Date.now();
    await this.sendRaw(data, {
      useHeaderPayload,
      allowEmptyResponse: true,
    });
    return Date.now() - start;
  }

  private async sendRaw(data: ArrayBuffer, options?: { useHeaderPayload?: boolean; allowEmptyResponse?: boolean }): Promise<ArrayBuffer> {
    try {
      return await this.sendRawOnce(data, options);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('socket hang up') || msg.includes('ECONNRESET')) {
        logger.warn({ error: msg }, 'Connection dropped, retrying request once');
        return this.sendRawOnce(data, options);
      }
      throw error;
    }
  }

  private sendRawOnce(data: ArrayBuffer, options?: { useHeaderPayload?: boolean; allowEmptyResponse?: boolean }): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const startedAtMs = Date.now();
      const body = Buffer.from(data);
      const requestMeta = this.decodeCommandMeta('request', body);
      const requestEvent = this.extractPaintRequestEvent(body, requestMeta);
      const threshold = this.config.postDataHeaderThreshold ?? 70;
      const useHeaderPayload = options?.useHeaderPayload ??
        (this.sendShortPayloadInHeader && body.length < threshold);
      const allowEmptyResponse = options?.allowEmptyResponse ?? false;
      this.logFrame('request', body, {
        host: this.config.host,
        port: this.config.port,
        path: '/WebVisuV3.bin',
        useHeaderPayload,
      });

      const headers: Record<string, string | number> = {
        'Accept': '*/*',
        'Content-Type': 'application/octet-stream',
        'Referer': this.config.referer ?? `https://${this.config.host}/webvisu/webvisu.htm`,
      };
      const cookieHeader = this.getCookieHeader();
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
      }
      if (useHeaderPayload) {
        headers['Content-Length'] = 0;
        headers['3S-Repl-Content'] = body.toString('base64');
      } else {
        headers['Content-Length'] = body.length;
      }

      const req = https.request({
        hostname: this.config.host,
        port: this.config.port,
        path: '/WebVisuV3.bin',
        method: 'POST',
        headers,
        agent: this.agent,
        timeout: this.config.requestTimeout,
      }, (res) => {
        this.captureCookies(res.headers['set-cookie']);
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          let responseBuf = Buffer.concat(chunks);
          if (responseBuf.byteLength === 0) {
            const headerPayload = this.decodeResponsePayloadHeader(res.headers['3s-repl-content']);
            if (headerPayload) {
              responseBuf = Buffer.from(headerPayload);
            }
          }
          this.logFrame('response', responseBuf, {
            status: res.statusCode ?? 'unknown',
            statusText: res.statusMessage ?? '',
            headers: res.headers,
          });
          if ((res.statusCode && res.statusCode >= 400) || responseBuf.byteLength === 0) {
            const status = res.statusCode ?? 'unknown';
            const statusText = res.statusMessage ?? '';
            const len = responseBuf.byteLength;
            if (allowEmptyResponse && (!res.statusCode || res.statusCode < 400) && len === 0) {
              resolve(new ArrayBuffer(0));
              return;
            }
            if (this.config.debugHttp) {
              logger.warn({
                status,
                statusText,
                headers: res.headers,
                responseLength: len,
                useHeaderPayload,
              }, 'Empty or error HTTP response');
            }
            reject(new Error(`HTTP ${status} ${statusText} (response length ${len})`));
            return;
          }
          if (this.config.debugHttp) {
            logger.debug({
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers,
              responseLength: responseBuf.byteLength,
            }, 'HTTP response received');
          }
          this.emitPaintFrame(
            responseBuf,
            res.statusCode ?? 0,
            startedAtMs,
            requestMeta,
            requestEvent,
          );
          resolve(responseBuf.buffer.slice(responseBuf.byteOffset, responseBuf.byteOffset + responseBuf.byteLength));
        });
        res.on('error', reject);
      });

      if (this.config.debugHttp) {
        logger.debug({
          host: this.config.host,
          port: this.config.port,
          path: '/WebVisuV3.bin',
          requestLength: body.length,
          useHeaderPayload,
        }, 'HTTP request sent');
      }

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      if (!useHeaderPayload) {
        req.write(body);
      }
      req.end();
    });
  }
}
