// Low-level binary read/write utilities for CoDeSys WebVisu wire format

const FRAME_MAGIC = 0xCD55;
const FRAME_HEADER_LENGTH = 16;
const FRAME_WIRE_HEADER_BYTES = 20;

// --- MBUI (Multi-Byte Unsigned Integer) ---

export function mbuiBytesNeeded(value: number): number {
  if (value < 0x80) return 1;
  if (value < 0x4000) return 2;
  if (value < 0x200000) return 3;
  if (value < 0x10000000) return 4;
  return 5;
}

export function writeMbui(writer: BinaryWriter, value: number): void {
  const numBytes = mbuiBytesNeeded(value);
  let v = value;
  for (let i = 0; i < numBytes - 1; i++) {
    writer.writeUint8((v & 0x7F) | 0x80);
    v >>>= 7;
  }
  writer.writeUint8(v & 0x7F);
}

export function readMbui(reader: BinaryReader): number {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = reader.readUint8();
    value |= (byte & 0x7F) << shift;
    shift += 7;
  } while (byte & 0x80);
  return value;
}

// --- TLV (Tag-Length-Value) ---

export class TlvWriter {
  private writer: BinaryWriter;

  constructor(writer: BinaryWriter) {
    this.writer = writer;
  }

  writeEntry(tag: number, data: Uint8Array): void {
    writeMbui(this.writer, tag);
    writeMbui(this.writer, data.length);
    this.writer.writeBytes(data);
  }

  writeUint32Entry(tag: number, value: number): void {
    const buf = new Uint8Array(4);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, value, true);
    this.writeEntry(tag, buf);
  }

  writeStringEntry(tag: number, str: string): void {
    const data = encodeString(str);
    this.writeEntry(tag, data);
  }
}

export interface TlvEntry {
  tag: number;
  data: Uint8Array;
}

export function readTlvEntries(reader: BinaryReader, length: number): TlvEntry[] {
  const entries: TlvEntry[] = [];
  const endPos = reader.position + length;
  while (reader.position < endPos) {
    const tag = readMbui(reader);
    const len = readMbui(reader);
    const data = reader.readBytes(len);
    entries.push({ tag, data: new Uint8Array(data) });
  }
  return entries;
}

export function findTlvEntry(entries: TlvEntry[], tag: number): TlvEntry | undefined {
  return entries.find(e => e.tag === tag);
}

export function tlvEntryUint32(entry: TlvEntry): number {
  const dv = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
  return dv.getUint32(0, true);
}

// --- Frame Builder ---

export function buildFrame(
  serviceGroup: number,
  serviceId: number,
  sessionId: number,
  content: Uint8Array
): ArrayBuffer {
  // webvisu.js/Eb.write writes a 20-byte wire header:
  // 16-byte logical header + 4 trailing reserved bytes.
  const totalLength = FRAME_WIRE_HEADER_BYTES + content.length;
  const buf = new ArrayBuffer(totalLength);
  const dv = new DataView(buf);

  dv.setUint16(0, FRAME_MAGIC, true);
  dv.setUint16(2, FRAME_HEADER_LENGTH, true);
  dv.setUint16(4, serviceGroup, true);
  dv.setUint16(6, serviceId, true);
  dv.setUint32(8, sessionId, true);
  dv.setUint32(12, content.length, true);
  dv.setUint16(16, 0, true);
  dv.setUint16(18, 0, true);

  const arr = new Uint8Array(buf);
  arr.set(content, FRAME_WIRE_HEADER_BYTES);

  return buf;
}

// --- Frame Parser ---

export interface ParsedFrame {
  serviceGroup: number;
  serviceId: number;
  sessionId: number;
  content: Uint8Array;
}

export function parseFrame(buf: ArrayBuffer): ParsedFrame {
  if (buf.byteLength < FRAME_WIRE_HEADER_BYTES) {
    throw new Error(`Frame too short: ${buf.byteLength} bytes (expected at least ${FRAME_WIRE_HEADER_BYTES})`);
  }
  const dv = new DataView(buf);

  const magic = dv.getUint16(0, true);
  if (magic !== FRAME_MAGIC) {
    throw new Error(`Invalid frame magic: 0x${magic.toString(16)} (expected 0xCD55)`);
  }

  const headerLength = dv.getUint16(2, true);
  const serviceGroup = dv.getUint16(4, true);
  const serviceId = dv.getUint16(6, true);
  const sessionId = dv.getUint32(8, true);
  const contentLength = dv.getUint32(12, true);
  if (headerLength < 12) {
    throw new Error(`Invalid header length: ${headerLength} (min 12)`);
  }
  // On-wire content starts after 4 bytes (magic + headerLength) plus logical headerLength.
  const contentOffset = 4 + headerLength;
  if (contentOffset + contentLength > buf.byteLength) {
    throw new Error(`Frame length mismatch: header=${headerLength} content=${contentLength} total=${buf.byteLength}`);
  }

  const content = new Uint8Array(buf, contentOffset, contentLength);

  return { serviceGroup, serviceId, sessionId, content };
}

// --- BinaryWriter ---

export class BinaryWriter {
  private chunks: Uint8Array[] = [];
  private current: Uint8Array;
  private pos: number = 0;

  constructor(initialSize: number = 256) {
    this.current = new Uint8Array(initialSize);
  }

  private ensure(bytes: number): void {
    if (this.pos + bytes > this.current.length) {
      // Grow buffer
      const newSize = Math.max(this.current.length * 2, this.pos + bytes);
      const newBuf = new Uint8Array(newSize);
      newBuf.set(this.current.subarray(0, this.pos));
      this.current = newBuf;
    }
  }

  writeUint8(value: number): void {
    this.ensure(1);
    this.current[this.pos++] = value & 0xFF;
  }

  writeUint16(value: number): void {
    this.ensure(2);
    this.current[this.pos++] = value & 0xFF;
    this.current[this.pos++] = (value >>> 8) & 0xFF;
  }

  writeInt16(value: number): void {
    this.writeUint16(value & 0xFFFF);
  }

  writeUint32(value: number): void {
    this.ensure(4);
    this.current[this.pos++] = value & 0xFF;
    this.current[this.pos++] = (value >>> 8) & 0xFF;
    this.current[this.pos++] = (value >>> 16) & 0xFF;
    this.current[this.pos++] = (value >>> 24) & 0xFF;
  }

  writeFloat32(value: number): void {
    this.ensure(4);
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value, true);
    const bytes = new Uint8Array(buf);
    this.current.set(bytes, this.pos);
    this.pos += 4;
  }

  writeBytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.current.set(data, this.pos);
    this.pos += data.length;
  }

  writeString(str: string): void {
    const encoded = encodeString(str);
    this.writeBytes(encoded);
  }

  writeNullTerminatedString(str: string): void {
    this.writeString(str);
    this.writeUint8(0);
  }

  toUint8Array(): Uint8Array {
    return this.current.subarray(0, this.pos);
  }

  get length(): number {
    return this.pos;
  }
}

// --- BinaryReader ---

export class BinaryReader {
  private dv: DataView;
  private _pos: number;

  constructor(buf: ArrayBuffer | Uint8Array, offset: number = 0) {
    if (buf instanceof Uint8Array) {
      this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
      this.dv = new DataView(buf, offset);
    }
    this._pos = 0;
  }

  get position(): number {
    return this._pos;
  }

  get remaining(): number {
    return this.dv.byteLength - this._pos;
  }

  readUint8(): number {
    const v = this.dv.getUint8(this._pos);
    this._pos += 1;
    return v;
  }

  readUint16(): number {
    const v = this.dv.getUint16(this._pos, true);
    this._pos += 2;
    return v;
  }

  readInt16(): number {
    const v = this.dv.getInt16(this._pos, true);
    this._pos += 2;
    return v;
  }

  readUint32(): number {
    const v = this.dv.getUint32(this._pos, true);
    this._pos += 4;
    return v;
  }

  readFloat32(): number {
    const v = this.dv.getFloat32(this._pos, true);
    this._pos += 4;
    return v;
  }

  readBytes(length: number): ArrayBuffer {
    const start = this.dv.byteOffset + this._pos;
    this._pos += length;
    // Copy to a new ArrayBuffer to avoid SharedArrayBuffer issues
    const slice = new Uint8Array(this.dv.buffer, start, length);
    const copy = new ArrayBuffer(length);
    new Uint8Array(copy).set(slice);
    return copy;
  }

  readString(length: number): string {
    const bytes = new Uint8Array(this.readBytes(length));
    return decodeString(bytes);
  }

  skip(bytes: number): void {
    this._pos += bytes;
  }
}

// --- String encoding (ISO-8859-1 compatible) ---

function encodeString(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xFF;
  }
  return bytes;
}

function decodeString(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}
