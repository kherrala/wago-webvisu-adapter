// CoDeSys WebVisu event tag constants.
// Reference: webvisu-deobfuscated.js EventType (line 4816)

export const EVENT_HEARTBEAT = 1;
export const EVENT_MOUSE_DOWN = 2;
export const EVENT_MOUSE_UP = 4;
export const EVENT_MOUSE_CLICK = 8;
export const EVENT_MOUSE_MOVE = 16;
export const EVENT_MOUSE_DBL_CLICK = 32;
export const EVENT_MOUSE_WHEEL = 64;
export const EVENT_KEY_DOWN = 128;
export const EVENT_KEY_UP = 256;
export const EVENT_KEY_PRESS = 257;
export const EVENT_VIEWPORT_INFO = 516;
export const EVENT_MOUSE_ENTER = 2048;
export const EVENT_MOUSE_OUT = 4096;
export const EVENT_CONTROL = 1048576;

const EVENT_NAMES: Record<number, string> = {
  [EVENT_HEARTBEAT]: 'Heartbeat',
  [EVENT_MOUSE_DOWN]: 'MouseDown',
  [EVENT_MOUSE_UP]: 'MouseUp',
  [EVENT_MOUSE_CLICK]: 'MouseClick',
  [EVENT_MOUSE_MOVE]: 'MouseMove',
  [EVENT_MOUSE_DBL_CLICK]: 'MouseDblClick',
  [EVENT_MOUSE_WHEEL]: 'MouseWheel',
  [EVENT_KEY_DOWN]: 'KeyDown',
  [EVENT_KEY_UP]: 'KeyUp',
  [EVENT_KEY_PRESS]: 'KeyPress',
  [EVENT_VIEWPORT_INFO]: 'ViewportInfo',
  [EVENT_MOUSE_ENTER]: 'MouseEnter',
  [EVENT_MOUSE_OUT]: 'MouseOut',
  [EVENT_CONTROL]: 'Control',
};

export function getEventName(eventTag: number): string {
  return EVENT_NAMES[eventTag] ?? `Event(${eventTag})`;
}

/**
 * Pack canvas coordinates into a single uint32.
 * Reference: webvisu-deobfuscated.js Point.Yc() (line 11273)
 *   (this.y >>> 0 & 65535 | this.x >>> 0 << 16) >>> 0
 */
export function packPoint(x: number, y: number): number {
  return ((((x >>> 0) & 0xffff) << 16) | ((y >>> 0) & 0xffff)) >>> 0;
}

export function unpackPointX(packed: number): number {
  return (packed >>> 16) & 0xffff;
}

export function unpackPointY(packed: number): number {
  return packed & 0xffff;
}

export function isPackedCoordinateEvent(eventTag: number): boolean {
  return eventTag === EVENT_MOUSE_DOWN
    || eventTag === EVENT_MOUSE_UP
    || eventTag === EVENT_MOUSE_CLICK
    || eventTag === EVENT_MOUSE_MOVE
    || eventTag === EVENT_MOUSE_DBL_CLICK;
}
