import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";

const DESKTOP_ACTIONS = [
  "screenshot",
  "mouse_move",
  "mouse_click",
  "mouse_double_click",
  "mouse_right_click",
  "mouse_drag",
  "mouse_scroll",
  "key_press",
  "type_text",
  "get_screen_size",
  "get_mouse_position",
] as const;

const MOUSE_BUTTONS = ["left", "right", "middle"] as const;

export const DesktopControlToolSchema = Type.Object({
  action: stringEnum(DESKTOP_ACTIONS),
  // Screenshot params
  region: Type.Optional(
    Type.Object({
      x: Type.Number(),
      y: Type.Number(),
      width: Type.Number(),
      height: Type.Number(),
    }),
  ),
  // Mouse movement and click params
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  // Drag params
  fromX: Type.Optional(Type.Number()),
  fromY: Type.Optional(Type.Number()),
  toX: Type.Optional(Type.Number()),
  toY: Type.Optional(Type.Number()),
  // Click params
  button: optionalStringEnum(MOUSE_BUTTONS),
  double: Type.Optional(Type.Boolean()),
  // Scroll params
  scrollAmount: Type.Optional(Type.Number()),
  // Key press params
  key: Type.Optional(Type.String()),
  modifiers: Type.Optional(Type.Array(Type.String())),
  // Type text params
  text: Type.Optional(Type.String()),
  // Common params
  delayMs: Type.Optional(Type.Number()),
});
