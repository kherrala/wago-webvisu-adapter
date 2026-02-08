// High-level message builders and response parsers for CoDeSys WebVisu protocol

import {
  BinaryWriter, BinaryReader, TlvWriter,
  buildFrame, parseFrame,
  readTlvEntries, findTlvEntry,
} from './binary';

// --- Request Builders ---

export function buildOpenConnection(
  plcAddress: string,
  commBufferSize: number,
  useLocalHost: boolean
): ArrayBuffer {
  const payload = `|${plcAddress}|${commBufferSize}|${useLocalHost ? 'true' : 'false'}|`;
  const writer = new BinaryWriter(payload.length + 4);
  // webvisu.js ($q + Wh(1)): 0x01 0x00 0x00 0x00 + pipe-delimited text.
  writer.writeUint8(1);
  writer.writeUint8(0);
  writer.writeUint8(0);
  writer.writeUint8(0);
  writer.writeString(payload);

  const bytes = writer.toUint8Array();
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function buildServiceRequest(
  serviceGroup: number,
  serviceId: number,
  sessionId: number,
  content: Uint8Array
): ArrayBuffer {
  // webvisu.js (Yb + Wh(2)): request type 2 prefix + framed payload.
  const frame = new Uint8Array(buildFrame(serviceGroup, serviceId, sessionId, content));
  const out = new Uint8Array(frame.length + 4);
  out[0] = 2;
  out.set(frame, 4);
  return out.buffer;
}

function writeMbuiFixed(writer: BinaryWriter, value: number, bytes: number): void {
  let v = value >>> 0;
  for (let i = 0; i < bytes - 1; i++) {
    writer.writeUint8((v & 0x7F) | 0x80);
    v >>>= 7;
  }
  writer.writeUint8(v & 0x7F);
}

function writeStringField(writer: BinaryWriter, tag: number, value: string): void {
  const lenWithNul = value.length + 1;
  let pad = 0;
  while ((lenWithNul + pad + 2) % 4 !== 0) {
    pad++;
  }
  const totalLen = lenWithNul + pad;

  writeMbuiFixed(writer, tag, 1);
  // webvisu.js mh(): force 3-byte MBUI length for these fields.
  writeMbuiFixed(writer, totalLen, 3);
  writer.writeString(value);
  writer.writeUint8(0);
  for (let i = 0; i < pad; i++) {
    writer.writeUint8(0);
  }
}

function buildLegacyLoginUserPayload(username: string): Uint8Array {
  // webvisu.js pv(): tag 16 payload with De(len, 4, 2) padding.
  const lenWithNul = username.length + 1;
  let pad = 0;
  while ((lenWithNul + pad + 2) % 4 !== 0) {
    pad++;
  }
  const totalLen = lenWithNul + pad;
  const payload = new Uint8Array(totalLen);
  for (let i = 0; i < username.length; i++) {
    payload[i] = username.charCodeAt(i) & 0xFF;
  }

  const writer = new BinaryWriter(totalLen + 8);
  const tlv = new TlvWriter(writer);
  tlv.writeEntry(16, payload);
  return writer.toUint8Array();
}

export interface OpenConnectionResponse {
  commBufferSize: number;
  intelByteOrder: boolean;
  sessionId: number;
  demoMode: boolean;
  supportsPostMethod: boolean;
}

export function parseOpenConnectionResponse(buf: ArrayBuffer): OpenConnectionResponse {
  // webvisu.js reads OpenConnection response as raw pipe-delimited text.
  const text = new TextDecoder('iso-8859-1')
    .decode(new Uint8Array(buf))
    .replace(/\x00+$/g, '');

  if (!text.startsWith('|')) {
    throw new Error(`Invalid OpenConnection response (expected leading "|"): "${text}"`);
  }
  const parts = text.split('|').filter(p => p.length > 0);
  if (parts.length < 4) {
    throw new Error(`Invalid OpenConnection response: "${text}"`);
  }

  return {
    commBufferSize: parseInt(parts[0], 10),
    intelByteOrder: parts[1] === '0',
    sessionId: parseInt(parts[2], 10),
    demoMode: parts[3] === 'true',
    supportsPostMethod: parts[4] === 'true',
  };
}

export function buildGetMyIP(_sessionId: number): ArrayBuffer {
  // webvisu.js (oA + Wh(3)): raw request type 3 with no frame wrapper.
  const writer = new BinaryWriter(4);
  writer.writeUint8(3);
  writer.writeUint8(0);
  writer.writeUint8(0);
  writer.writeUint8(0);

  const bytes = writer.toUint8Array();
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export function buildBenchmark(): ArrayBuffer {
  // webvisu.js (Ty + Wh(100)): raw request type 100 with no frame wrapper.
  const writer = new BinaryWriter(4);
  writer.writeUint8(100);
  writer.writeUint8(0);
  writer.writeUint8(0);
  writer.writeUint8(0);

  const bytes = writer.toUint8Array();
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export function parseGetMyIPResponse(buf: ArrayBuffer): string {
  // webvisu.js reads this response as raw text and extracts the first IPv4 token.
  const text = new TextDecoder('iso-8859-1')
    .decode(new Uint8Array(buf))
    .replace(/\x00+$/g, '');
  const tokens = text.split('|');
  for (const token of tokens) {
    if (token.startsWith('IPv4:')) {
      return token.slice('IPv4:'.length).trim();
    }
  }
  return text.replace('IPv4:', '').trim();
}

export function buildDeviceSession(
  sessionId: number,
  clientIp: string,
  clientName: string = 'WebVisualization',
  clientVersion: string = '3.5.17.0',
  sessionFlags: number = 3
): ArrayBuffer {
  // webvisu.js Qy(): service (1,10)
  // tag 131 -> Gy() payload
  // tag 70  -> flags
  const gyWriter = new BinaryWriter(256);
  // tag 64: constant 0xABCDABCD, length encoded with 3-byte MBUI.
  writeMbuiFixed(gyWriter, 64, 1);
  writeMbuiFixed(gyWriter, 4, 3);
  gyWriter.writeUint32(0xABCDABCD);
  writeStringField(gyWriter, 65, clientName);
  writeStringField(gyWriter, 67, clientIp);
  writeStringField(gyWriter, 68, clientVersion);
  writeStringField(gyWriter, 69, clientVersion);

  const gyPayload = gyWriter.toUint8Array();
  const writer = new BinaryWriter(320);
  writeMbuiFixed(writer, 131, 2);
  // webvisu.js mk(): uses 2-byte MBUI for this length when possible.
  writeMbuiFixed(writer, gyPayload.length, 2);
  writer.writeBytes(gyPayload);
  writeMbuiFixed(writer, 70, 1);
  writeMbuiFixed(writer, 4, 3);
  writer.writeUint32(sessionFlags);

  return buildServiceRequest(1, 10, sessionId, writer.toUint8Array());
}

export interface DeviceSessionResponse {
  deviceSessionId: number;
  error: number;
  cryptType: number;
}

export function parseDeviceSessionResponse(buf: ArrayBuffer): DeviceSessionResponse {
  const frame = parseFrame(buf);
  const reader = new BinaryReader(frame.content);
  const entries = readTlvEntries(reader, frame.content.length);

  let deviceSessionId = 0;
  let cryptType = 0;
  let error = 0;

  for (const entry of entries) {
    if (entry.tag === 33 && entry.data.length >= 4) {
      deviceSessionId = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength).getUint32(0, true);
    } else if (entry.tag === 70 && entry.data.length >= 4) {
      cryptType = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength).getUint32(0, true);
    } else if (entry.tag === 65407 && entry.data.length >= 2) {
      error = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength).getUint16(0, true);
    }
  }

  // webvisu.js: if error == 770, force crypt type to 1.
  if (error === 770) {
    cryptType = 1;
  }

  return { deviceSessionId, error, cryptType };
}

export interface DeviceCryptChallengeResponse {
  result: number;
  token: number;
  publicKeyPem: string | null;
  challenge: Uint8Array | null;
}

export function buildDeviceCryptChallenge(sessionId: number, cryptType: number = 2): ArrayBuffer {
  // webvisu.js Oy(): service (1,2), Dn(cryptType, 1)
  const writer = new BinaryWriter(32);
  // Dn(): tag 34 len(4,3) value, tag 37 len(4,3) value
  writeMbuiFixed(writer, 34, 1);
  writeMbuiFixed(writer, 4, 3);
  writer.writeUint32(cryptType);
  writeMbuiFixed(writer, 37, 1);
  writeMbuiFixed(writer, 4, 3);
  writer.writeUint32(1);
  return buildServiceRequest(1, 2, sessionId, writer.toUint8Array());
}

export function buildDeviceLoginChallenge(
  sessionId: number,
  username: string,
  encryptedPassword: Uint8Array
): ArrayBuffer {
  // webvisu.js Py(): service (1,2), Dn(2,2), tag129(Zt(username, encryptedPassword))
  const ztWriter = new BinaryWriter(512);
  // Zt(): tag16 + mh(username), tag17 + len(3-byte) + encrypted bytes
  writeStringField(ztWriter, 16, username);
  writeMbuiFixed(ztWriter, 17, 1);
  writeMbuiFixed(ztWriter, encryptedPassword.length, 3);
  ztWriter.writeBytes(encryptedPassword);
  const ztPayload = ztWriter.toUint8Array();

  const writer = new BinaryWriter(640);
  // Dn(2,2)
  writeMbuiFixed(writer, 34, 1);
  writeMbuiFixed(writer, 4, 3);
  writer.writeUint32(2);
  writeMbuiFixed(writer, 37, 1);
  writeMbuiFixed(writer, 4, 3);
  writer.writeUint32(2);
  // this.J.u(129); this.mk(...)
  writeMbuiFixed(writer, 129, 2);
  // mk() chooses 2-byte MBUI for small payload sizes.
  writeMbuiFixed(writer, ztPayload.length, 2);
  writer.writeBytes(ztPayload);
  return buildServiceRequest(1, 2, sessionId, writer.toUint8Array());
}

export function parseDeviceCryptChallengeResponse(buf: ArrayBuffer): DeviceCryptChallengeResponse {
  const frame = parseFrame(buf);
  const reader = new BinaryReader(frame.content);
  const entries = readTlvEntries(reader, frame.content.length);

  let result = 0;
  let token = 0;
  let publicKeyPem: string | null = null;
  let challenge: Uint8Array | null = null;

  for (const entry of entries) {
    if (entry.tag === 65410 || entry.tag === 130) {
      const innerReader = new BinaryReader(entry.data);
      const innerEntries = readTlvEntries(innerReader, entry.data.length);
      for (const inner of innerEntries) {
        if (inner.tag === 32 && inner.data.length >= 2) {
          result = new DataView(inner.data.buffer, inner.data.byteOffset, inner.data.byteLength).getUint16(0, true);
        }
      }
    } else if (entry.tag === 39) {
      publicKeyPem = new TextDecoder('iso-8859-1')
        .decode(entry.data)
        .replace(/\x00+$/g, '');
    } else if (entry.tag === 38) {
      challenge = new Uint8Array(entry.data);
    } else if (entry.tag === 65315 && entry.data.length >= 4) {
      token = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength).getUint32(0, true);
    }
  }

  return { result, token, publicKeyPem, challenge };
}

export function buildDeviceLogin(sessionId: number, cryptType: number = 0, username: string = ''): ArrayBuffer {
  // webvisu.js qd step0 for non-challenge login: qm("", "", 0, cryptType), service (1,2).
  const writer = new BinaryWriter(96);
  // qm(): tag34 len(4,3) + value, then tag129 with 2-byte length.
  writeMbuiFixed(writer, 34, 1);
  writeMbuiFixed(writer, 4, 3);
  writer.writeUint32(cryptType);
  const userPayload = buildLegacyLoginUserPayload(username);
  writeMbuiFixed(writer, 129, 2);
  writeMbuiFixed(writer, userPayload.length, 2);
  writer.writeBytes(userPayload);
  return buildServiceRequest(1, 2, sessionId, writer.toUint8Array());
}

export interface DeviceLoginResponse {
  result: number;
  deviceSessionId: number;
}

export function parseDeviceLoginResponse(buf: ArrayBuffer): DeviceLoginResponse {
  const frame = parseFrame(buf);
  const reader = new BinaryReader(frame.content);
  const entries = readTlvEntries(reader, frame.content.length);

  let result = 0;
  let deviceSessionId = 0;
  for (const entry of entries) {
    if (entry.tag !== 65410 && entry.tag !== 130) {
      continue;
    }
    const innerReader = new BinaryReader(entry.data);
    const innerEntries = readTlvEntries(innerReader, entry.data.length);
    for (const inner of innerEntries) {
      if (inner.tag === 32 && inner.data.length >= 2) {
        result = new DataView(inner.data.buffer, inner.data.byteOffset, inner.data.byteLength).getUint16(0, true);
      } else if (inner.tag === 33 && inner.data.length >= 4) {
        deviceSessionId = new DataView(inner.data.buffer, inner.data.byteOffset, inner.data.byteLength).getUint32(0, true);
      }
    }
  }

  return { result, deviceSessionId };
}

export function buildRegisterClient(
  application: string,
  clientName: string,
  clientIp: string,
  sessionId: number
): ArrayBuffer {
  const writer = new BinaryWriter(256);
  const tlv = new TlvWriter(writer);

  // Tag 1: Application name (null-terminated) + padding + flags
  const appWriter = new BinaryWriter(128);
  appWriter.writeNullTerminatedString(application);
  // Pad to align
  while (appWriter.length % 4 !== 0) {
    appWriter.writeUint8(0);
  }
  // Flags: 0x80000 (524288)
  appWriter.writeUint32(0x80000);
  tlv.writeEntry(1, appWriter.toUint8Array());

  // Tag 2: Client info records (84 bytes each)
  // Record 1: type=1 (client name)
  const infoWriter = new BinaryWriter(168);

  // Client name record: type(4) + string(80 padded)
  infoWriter.writeUint32(1); // type = client name
  const nameBytes = new Uint8Array(80);
  for (let i = 0; i < Math.min(clientName.length, 79); i++) {
    nameBytes[i] = clientName.charCodeAt(i) & 0xFF;
  }
  infoWriter.writeBytes(nameBytes);

  // Client IP record: type(4) + string(80 padded)
  infoWriter.writeUint32(2); // type = client IP
  const ipBytes = new Uint8Array(80);
  for (let i = 0; i < Math.min(clientIp.length, 79); i++) {
    ipBytes[i] = clientIp.charCodeAt(i) & 0xFF;
  }
  infoWriter.writeBytes(ipBytes);

  tlv.writeEntry(2, infoWriter.toUint8Array());

  return buildServiceRequest(4, 1, sessionId, writer.toUint8Array());
}

export interface RegisterClientResponse {
  clientId: number;
  error: string | null;
}

export function parseRegisterClientResponse(buf: ArrayBuffer): RegisterClientResponse {
  const frame = parseFrame(buf);
  const reader = new BinaryReader(frame.content);
  const entries = readTlvEntries(reader, frame.content.length);

  for (const entry of entries) {
    if (entry.tag === 65407) {
      return { clientId: 0, error: 'Visu not supported by the PLC' };
    }
    if (entry.data.length < 4) {
      continue;
    }

    const clientId = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength).getUint32(0, true);
    if (clientId < 0xB0000000) {
      return { clientId, error: null };
    }

    const errorMap: Record<number, string> = {
      0xFFFFFFFA: 'Visualization is not allowed',
      0xFFFFFFFC: 'No more memory on the PLC',
      0xFFFFFFFD: 'Connection to invalid application',
      0xFFFFFFF9: 'Too many clients are registering at the same time',
    };
    return { clientId, error: errorMap[clientId] || `Unknown error: 0x${clientId.toString(16)}` };
  }

  return { clientId: 0, error: 'Unexpected format of RegisterClient response' };
}

export function buildIsRegisteredClient(clientId: number, sessionId: number): ArrayBuffer {
  const writer = new BinaryWriter(16);
  const tlv = new TlvWriter(writer);
  tlv.writeUint32Entry(3, clientId);
  return buildServiceRequest(4, 3, sessionId, writer.toUint8Array());
}

export type RegistrationStatus = 'registered' | 'pending' | 'error' | 'invalid';

export function parseIsRegisteredResponse(buf: ArrayBuffer): { status: RegistrationStatus } {
  const frame = parseFrame(buf);
  const reader = new BinaryReader(frame.content);
  const entries = readTlvEntries(reader, frame.content.length);

  for (const entry of entries) {
    if (entry.tag === 65407) {
      return { status: 'error' };
    }
    if (entry.data.length < 4) {
      continue;
    }

    const status = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength).getUint32(0, true);
    const statusMap: Record<number, RegistrationStatus> = {
      0: 'registered',
      1: 'pending',
      2: 'error',
      3: 'invalid',
    };
    return { status: statusMap[status] || 'error' };
  }

  return { status: 'error' };
}

export function buildRemoveClient(clientId: number, sessionId: number): ArrayBuffer {
  const writer = new BinaryWriter(16);
  const tlv = new TlvWriter(writer);
  tlv.writeUint32Entry(2, clientId);
  return buildServiceRequest(4, 2, sessionId, writer.toUint8Array());
}

// --- Event Builders ---

function buildEventPayload(
  tag: number,
  clientId: number,
  param1: number,
  param2: number,
  extraData?: Uint8Array
): Uint8Array {
  const writer = new BinaryWriter(64);
  const outerTlv = new TlvWriter(writer);

  // Build inner TLV content (tag 132 wrapper)
  const innerWriter = new BinaryWriter(64);
  const innerTlv = new TlvWriter(innerWriter);

  // Tag 1: 16-byte event header
  const eventWriter = new BinaryWriter(16);
  eventWriter.writeUint32(tag);
  eventWriter.writeUint32(param1);
  eventWriter.writeUint32(param2);
  eventWriter.writeUint32(clientId);
  innerTlv.writeEntry(1, eventWriter.toUint8Array());

  // Tag 2: extra data (optional)
  if (extraData && extraData.length > 0) {
    innerTlv.writeEntry(2, extraData);
  }

  // Wrap in tag 132
  outerTlv.writeEntry(132, innerWriter.toUint8Array());

  return writer.toUint8Array();
}

export function buildGetPaintData(
  eventPayload: Uint8Array,
  sessionId: number
): ArrayBuffer {
  return buildServiceRequest(4, 4, sessionId, eventPayload);
}

export function buildHeartbeat(clientId: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(1, clientId, 0, 0);
  return buildGetPaintData(payload, sessionId);
}

function packPointToUint32(x: number, y: number): number {
  return ((((x >>> 0) & 0xffff) << 16) | ((y >>> 0) & 0xffff)) >>> 0;
}

export function buildMouseDown(clientId: number, x: number, y: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(2, clientId, packPointToUint32(x, y), 0);
  return buildGetPaintData(payload, sessionId);
}

export function buildMouseMove(clientId: number, x: number, y: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(16, clientId, packPointToUint32(x, y), 0);
  return buildGetPaintData(payload, sessionId);
}

export function buildMouseUp(clientId: number, x: number, y: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(4, clientId, packPointToUint32(x, y), 0);
  return buildGetPaintData(payload, sessionId);
}

export function buildViewportEvent(
  clientId: number,
  width: number,
  height: number,
  dpr: number,
  sessionId: number
): ArrayBuffer {
  const viewportFlags = 0; // BestFit/BestFitForDialogs/ScaleTypeIsotropic all disabled.
  const extraWriter = new BinaryWriter(32);
  extraWriter.writeInt16(0);          // viewport X
  extraWriter.writeInt16(0);          // viewport Y
  extraWriter.writeInt16(width - 1);  // width - 1
  extraWriter.writeInt16(height - 1); // height - 1
  extraWriter.writeFloat32(dpr);      // device pixel ratio

  const payload = buildEventPayload(516, clientId, viewportFlags, 0, extraWriter.toUint8Array());
  return buildGetPaintData(payload, sessionId);
}

export function buildCapabilitiesEvent(clientId: number, sessionId: number): ArrayBuffer {
  const extraWriter = new BinaryWriter(16);
  extraWriter.writeUint32(0x70000);  // protocol version 458752
  extraWriter.writeUint32(7);         // supported features bitmask
  extraWriter.writeUint32(0);         // flags: no keyboard, no touch

  const payload = buildEventPayload(1048576, clientId, 0, 0, extraWriter.toUint8Array());
  return buildGetPaintData(payload, sessionId);
}

export function buildStartVisuEvent(clientId: number, visuName: string, sessionId: number): ArrayBuffer {
  const extraWriter = new BinaryWriter(64);
  extraWriter.writeUint32(1);  // start command
  extraWriter.writeNullTerminatedString(visuName);

  const payload = buildEventPayload(1048576, clientId, 0, 0, extraWriter.toUint8Array());
  return buildGetPaintData(payload, sessionId);
}

export function buildContinuation(continuationToken: number, sessionId: number): ArrayBuffer {
  const writer = new BinaryWriter(32);
  const outerTlv = new TlvWriter(writer);

  // Tag 132 containing tag 4 with continuation token
  const innerWriter = new BinaryWriter(16);
  const innerTlv = new TlvWriter(innerWriter);
  innerTlv.writeUint32Entry(4, continuationToken);

  outerTlv.writeEntry(132, innerWriter.toUint8Array());

  return buildServiceRequest(4, 4, sessionId, writer.toUint8Array());
}

// --- Paint Data Response Parser ---

export interface PaintDataResponse {
  error: number;
  commandCount: number;
  commands: Uint8Array;
  continuation: number;
}

export function parsePaintDataResponse(buf: ArrayBuffer): PaintDataResponse {
  const frame = parseFrame(buf);
  const reader = new BinaryReader(frame.content);
  const entries = readTlvEntries(reader, frame.content.length);

  let error = 0;
  let commandCount = 0;
  let commands = new Uint8Array(0);
  let continuation = 0;

  // Find the paint data container (tag 132 or 129)
  const container = findTlvEntry(entries, 132) || findTlvEntry(entries, 129);
  if (container) {
    const containerReader = new BinaryReader(container.data);
    const innerEntries = readTlvEntries(containerReader, container.data.length);

    for (const inner of innerEntries) {
      if (inner.tag === 1 && inner.data.length >= 4) {
        // Error code
        error = new DataView(inner.data.buffer, inner.data.byteOffset, inner.data.byteLength).getUint32(0, true);
      } else if (inner.tag === 2 && inner.data.length >= 16) {
        // Paint header: unused(4) + commandCount(4) + totalSize(4) + continuation(4)
        const hdr = new DataView(inner.data.buffer, inner.data.byteOffset, inner.data.byteLength);
        commandCount = hdr.getUint32(4, true);
        continuation = hdr.getUint32(12, true);
      } else if (inner.tag === 3) {
        // Raw paint command data
        commands = new Uint8Array(inner.data);
      } else if (inner.tag === 4) {
        // Finish marker (0 continuation remaining)
        continuation = 0;
      }
    }
  }

  return { error, commandCount, commands, continuation };
}
