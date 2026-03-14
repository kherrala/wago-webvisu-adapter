// UI event builders for CoDeSys WebVisu protocol.
// Reference: webvisu-deobfuscated.js EventMessage (line 4823), buildEventTlv (line 4662)

import { BinaryWriter, TlvWriter } from '../protocol/binary';
import { buildServiceRequest } from '../protocol/messages';
import {
  EVENT_HEARTBEAT,
  EVENT_MOUSE_DOWN,
  EVENT_MOUSE_UP,
  EVENT_MOUSE_CLICK,
  EVENT_MOUSE_MOVE,
  EVENT_MOUSE_DBL_CLICK,
  EVENT_MOUSE_WHEEL,
  EVENT_KEY_DOWN,
  EVENT_KEY_UP,
  EVENT_KEY_PRESS,
  EVENT_MOUSE_ENTER,
  EVENT_MOUSE_OUT,
  EVENT_CONTROL,
  EVENT_VIEWPORT_INFO,
  packPoint,
} from './event-types';

/**
 * Build TLV tag 2 extra data for canvas mouse events.
 *
 * The original WebVisu client sends this with every mouse event:
 * - 8 bytes: Visualization target (UInt64 encoding page container hierarchy)
 * - 4 bytes: Binary coordinates (int16 LE x, int16 LE y)
 *
 * Without this data, the PLC updates the visual rendering state but may not
 * synchronize widget interaction state (e.g., dropdown click mapping falls
 * out of sync with scroll position after arrow clicks).
 *
 * Reference: webvisu-deobfuscated.js cy() (line 4680), Util.$e() (line 11738)
 */
function buildMouseEventExtraData(x: number, y: number): Uint8Array {
  const buf = new Uint8Array(12);
  const dv = new DataView(buf.buffer);
  // Bytes 0-7: Visualization target UInt64(0, 0) — flat page, no dialogs
  dv.setUint32(0, 0, true);   // .kb (low 32 bits)
  dv.setUint32(4, 0, true);   // .zb (high 32 bits)
  // Bytes 8-11: Binary coordinates (same coords as param1, different encoding)
  dv.setInt16(8, x, true);    // int16 LE x
  dv.setInt16(10, y, true);   // int16 LE y
  return buf;
}

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
  const payload = buildEventPayload(EVENT_HEARTBEAT, clientId, 0, 0);
  return buildGetPaintData(payload, sessionId);
}

export function buildMouseDown(clientId: number, x: number, y: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_MOUSE_DOWN, clientId, packPoint(x, y), 0, buildMouseEventExtraData(x, y));
  return buildGetPaintData(payload, sessionId);
}

export function buildMouseMove(clientId: number, x: number, y: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_MOUSE_MOVE, clientId, packPoint(x, y), 0, buildMouseEventExtraData(x, y));
  return buildGetPaintData(payload, sessionId);
}

export function buildMouseUp(clientId: number, x: number, y: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_MOUSE_UP, clientId, packPoint(x, y), 0, buildMouseEventExtraData(x, y));
  return buildGetPaintData(payload, sessionId);
}

export function buildMouseClick(clientId: number, x: number, y: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_MOUSE_CLICK, clientId, packPoint(x, y), 0, buildMouseEventExtraData(x, y));
  return buildGetPaintData(payload, sessionId);
}

export function buildMouseDoubleClick(clientId: number, x: number, y: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_MOUSE_DBL_CLICK, clientId, packPoint(x, y), 0, buildMouseEventExtraData(x, y));
  return buildGetPaintData(payload, sessionId);
}

export function buildMouseWheel(clientId: number, param1: number, param2: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_MOUSE_WHEEL, clientId, param1 >>> 0, param2 >>> 0);
  return buildGetPaintData(payload, sessionId);
}

export function buildKeyDown(clientId: number, keyCode: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_KEY_DOWN, clientId, keyCode >>> 0, 0);
  return buildGetPaintData(payload, sessionId);
}

export function buildKeyUp(clientId: number, keyCode: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_KEY_UP, clientId, keyCode >>> 0, 0);
  return buildGetPaintData(payload, sessionId);
}

export function buildKeyPress(clientId: number, keyCode: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_KEY_PRESS, clientId, keyCode >>> 0, 0);
  return buildGetPaintData(payload, sessionId);
}

export function buildMouseEnter(clientId: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_MOUSE_ENTER, clientId, 0, 0);
  return buildGetPaintData(payload, sessionId);
}

export function buildMouseOut(clientId: number, sessionId: number): ArrayBuffer {
  const payload = buildEventPayload(EVENT_MOUSE_OUT, clientId, 0, 0);
  return buildGetPaintData(payload, sessionId);
}

export function buildRawInputEvent(
  eventTag: number,
  clientId: number,
  param1: number,
  param2: number,
  sessionId: number,
  extraData?: Uint8Array
): ArrayBuffer {
  const payload = buildEventPayload(eventTag >>> 0, clientId, param1 >>> 0, param2 >>> 0, extraData);
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

  const payload = buildEventPayload(EVENT_VIEWPORT_INFO, clientId, viewportFlags, 0, extraWriter.toUint8Array());
  return buildGetPaintData(payload, sessionId);
}

export function buildCapabilitiesEvent(clientId: number, sessionId: number): ArrayBuffer {
  const extraWriter = new BinaryWriter(16);
  extraWriter.writeUint32(0x70000);  // protocol version 458752
  extraWriter.writeUint32(7);         // supported features bitmask
  extraWriter.writeUint32(0);         // flags: no keyboard, no touch

  const payload = buildEventPayload(EVENT_CONTROL, clientId, 0, 0, extraWriter.toUint8Array());
  return buildGetPaintData(payload, sessionId);
}

export function buildStartVisuEvent(clientId: number, visuName: string, sessionId: number): ArrayBuffer {
  const extraWriter = new BinaryWriter(64);
  extraWriter.writeUint32(1);  // start command
  extraWriter.writeNullTerminatedString(visuName);

  const payload = buildEventPayload(EVENT_CONTROL, clientId, 0, 0, extraWriter.toUint8Array());
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
