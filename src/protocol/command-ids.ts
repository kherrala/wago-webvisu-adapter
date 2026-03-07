// Paint command ID constants — single source of truth.
// Used by paint-commands.ts (parsing) and debug-renderer.ts (rendering).

export const CMD_DRAW_SHAPE = 1;
export const CMD_DRAW_POLYGON = 2;
export const CMD_DRAW_TEXT_LEGACY = 3;
export const CMD_SET_FILL_COLOR = 4;
export const CMD_SET_PEN_STYLE = 5;
export const CMD_SET_FONT = 6;
export const CMD_CLEAR_RECT = 7;
export const CMD_SET_CLIP_RECT = 8;
export const CMD_RESTORE_CLIP_RECT = 9;
export const CMD_DRAW_TEXT_LEGACY_UTF16 = 11;
export const CMD_LAYER_SWITCH = 18;
export const CMD_DRAW_IMAGE = 19;
export const CMD_FILL_3D_RECT = 23;
export const CMD_SET_AREA_STYLE_LEGACY = 30;
export const CMD_INIT_VISUALIZATION = 37;
export const CMD_TOUCH_HANDLING_FLAGS = 42;
export const CMD_TOUCH_RECTANGLES = 43;
export const CMD_DRAW_POINTS = 44;
export const CMD_DRAW_PRIMITIVE = 45;
export const CMD_DRAW_TEXT = 46;
export const CMD_DRAW_TEXT_UTF16 = 47;
export const CMD_SET_AREA_STYLE = 48;
export const CMD_DRAW_POLYGON_FLOAT = 59;
export const CMD_DRAW_PRIMITIVE_FLOAT_QUAD = 60;
export const CMD_DRAW_PRIMITIVE_FLOAT_RECT = 61;
export const CMD_SET_RENDER_PARAMETER = 66;
export const CMD_SET_CORNER_RADIUS = 73;
export const CMD_CLEAR_RECT_ALT = 93;
export const CMD_CLEAR_ALL = 105;
export const CMD_SET_COMPOSITE_MODE = 106;
