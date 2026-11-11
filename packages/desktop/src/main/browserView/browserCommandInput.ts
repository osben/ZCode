import type { BrowserKeyModifier, BrowserMouseButton } from "@zcode/shared";
import { RESOLVE_SCRIPT } from "./browserCommandScripts.js";
import type { BrowserPoint, ControlledView } from "./browserCommandTypes.js";
import { withFocusedFrameSession } from "./browserVirtualClipboard.js";

/**
 * Keyboard modifiers → CDP modifiers bitmask (Alt=1, Control=2, Meta=4, Shift=8).
 * click/press/drag all reuse this mapping and pass it through to dispatchMouseEvent/dispatchKeyEvent.
 */
const MODIFIER_BITS: Record<BrowserKeyModifier, number> = {
  Alt: 1,
  Control: 2,
  ControlOrMeta: process.platform === "darwin" ? 4 : 2,
  Meta: 4,
  Shift: 8,
};

/**
 * Common key names → CDP Input.dispatchKeyEvent parameters.
 * Unmapped keys are passed through as-is (with only the key field) for the engine to interpret.
 */
const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
};

const MODIFIER_KEY_MAP: Record<
  BrowserKeyModifier,
  { code: string; windowsVirtualKeyCode: number }
> = {
  Alt: { code: "AltLeft", windowsVirtualKeyCode: 18 },
  Control: { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  ControlOrMeta:
    process.platform === "darwin"
      ? { code: "MetaLeft", windowsVirtualKeyCode: 91 }
      : { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91 },
  Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16 },
};

function normalizeCuaKey(raw: string): string {
  const key = raw.trim();
  const alias: Record<string, string> = {
    alt: "Alt",
    option: "Alt",
    control: "Control",
    ctrl: "Control",
    controlormeta: process.platform === "darwin" ? "Meta" : "Control",
    cmd: "Meta",
    meta: "Meta",
    super: "Meta",
    win: "Meta",
    shift: "Shift",
    esc: "Escape",
    return: "Enter",
    space: "Space",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
  };
  return alias[key.toLowerCase()] ?? key;
}

function asModifier(key: string): BrowserKeyModifier | undefined {
  return ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(key)
    ? (key as BrowserKeyModifier)
    : undefined;
}

function keyDefinition(keyName: string): {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
} {
  const known = KEY_MAP[keyName];
  if (known) return known;
  const modifier = asModifier(keyName);
  if (modifier) return { key: modifier, ...MODIFIER_KEY_MAP[modifier] };
  if (/^[a-z]$/iu.test(keyName)) {
    const upper = keyName.toUpperCase();
    return { key: keyName, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/u.test(keyName)) {
    return {
      key: keyName,
      code: `Digit${keyName}`,
      windowsVirtualKeyCode: keyName.charCodeAt(0),
    };
  }
  return { key: keyName };
}

export function modifiersBitmask(mods?: readonly BrowserKeyModifier[]): number {
  if (!mods || mods.length === 0) return 0;
  let bits = 0;
  for (const m of mods) bits |= MODIFIER_BITS[m];
  return bits;
}

/** Resolve the center coordinates of a ref element; return null when missing or when the result has an invalid shape. */
export async function resolveRefCenter(
  view: ControlledView,
  ref: string,
): Promise<BrowserPoint | null> {
  const raw = (await view.webContents.executeJavaScript(RESOLVE_SCRIPT(ref))) as {
    cx?: unknown;
    cy?: unknown;
  } | null;
  if (!raw || typeof raw.cx !== "number" || typeof raw.cy !== "number") return null;
  return { cx: raw.cx, cy: raw.cy };
}

/** Send a real CDP mouse click at the given coordinates (mouseMoved→mousePressed→mouseReleased). */
export async function dispatchClickAt(
  view: ControlledView,
  center: BrowserPoint,
  button: BrowserMouseButton,
  doubleClick: boolean,
  modifiers = 0,
): Promise<void> {
  const clickCount = doubleClick ? 2 : 1;
  // Omit this field when modifiers=0 to match existing tests that assert no modifiers property.
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.cx,
    y: center.cy,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod,
  });
}

/**
 * Drag from the start to the end: mousePressed@from → interpolated mouseMoved events →
 * mouseReleased@to (with modifiers). During the drag, set buttons:1 on mouseMoved to tell the engine
 * the left button is held, distinguishing a drag from ordinary movement.
 */
export async function dispatchDrag(
  view: ControlledView,
  from: BrowserPoint,
  to: BrowserPoint,
  modifiers = 0,
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {};
  const STEPS = 10;
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.cx,
    y: from.cy,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.cx,
    y: from.cy,
    button: "left",
    clickCount: 1,
    ...mod,
  });
  for (let i = 1; i <= STEPS; i++) {
    const x = Math.round(from.cx + ((to.cx - from.cx) * i) / STEPS);
    const y = Math.round(from.cy + ((to.cy - from.cy) * i) / STEPS);
    await view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      buttons: 1,
      ...mod,
    });
  }
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.cx,
    y: to.cy,
    button: "left",
    clickCount: 1,
    ...mod,
  });
}

/** Drag input: preserve each point in the caller's path instead of rebuilding a hand-drawn/curved path as a straight line. */
export async function dispatchDragPath(
  view: ControlledView,
  path: readonly { x: number; y: number }[],
  modifiers = 0,
): Promise<void> {
  const [first, ...rest] = path;
  if (!first) throw new Error("cua_drag requires a non-empty path");
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: first.x,
    y: first.y,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: first.x,
    y: first.y,
    button: "left",
    clickCount: 1,
    ...mod,
  });
  let last = first;
  try {
    for (const point of rest) {
      last = point;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        ...mod,
      });
    }
  } finally {
    await view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: last.x,
      y: last.y,
      button: "left",
      clickCount: 1,
      ...mod,
    });
  }
}

/** CUA scroll: move to the anchor point, then send real wheel input from that position. */
export async function dispatchScrollGesture(
  view: ControlledView,
  point: BrowserPoint,
  scrollX: number,
  scrollY: number,
  modifiers = 0,
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.cx,
    y: point.cy,
    ...mod,
  });
  // An Electron 41 / Chromium 146 <webview> guest silently succeeds on
  // Input.synthesizeScrollGesture without emitting a wheel event, so the page does not scroll.
  // mouseWheel remains trusted input at the anchor point and preserves nested scroll areas and wheel-handler semantics.
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.cx,
    y: point.cy,
    deltaX: scrollX,
    deltaY: scrollY,
    ...mod,
  });
}

const SEND_INPUT_KEY_CODES: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

const SEND_INPUT_MODIFIERS: Array<[number, "alt" | "control" | "meta" | "shift"]> = [
  [1, "alt"],
  [2, "control"],
  [4, "meta"],
  [8, "shift"],
];

function keyText(keyName: string, modifiers: number): string | undefined {
  if (modifiers & 7) return undefined;
  if (keyName === "Enter") return "\r";
  if (keyName === "Space") return " ";
  if ([...keyName].length !== 1) return undefined;
  if (!(modifiers & 8)) return keyName;
  return /^[a-z]$/iu.test(keyName) ? keyName.toUpperCase() : undefined;
}

// The guest main frame's CDP Input.dispatchKeyEvent routes by the focus of the whole window: when the guest lacks focus, keys land on
// the ZCode host page (Esc stops the session, Enter/Backspace edit the input box). sendInputEvent posts directly to the guest's
// own RenderWidgetHost; when focus is in a cross-process iframe, that iframe's CDP session likewise does not route by window focus.
async function dispatchKeyEvent(
  view: ControlledView,
  type: "keyDown" | "keyUp",
  keyName: string,
  modifiers: number,
  sessionId: string | undefined,
): Promise<void> {
  const text = type === "keyDown" ? keyText(keyName, modifiers) : undefined;
  if (sessionId != null) {
    await view.cdp.send(
      "Input.dispatchKeyEvent",
      {
        type,
        ...keyDefinition(keyName),
        ...(modifiers > 0 ? { modifiers } : {}),
        ...(text == null ? {} : { text }),
      },
      sessionId,
    );
    return;
  }
  const keyCode = SEND_INPUT_KEY_CODES[keyName] ?? keyName;
  const names = SEND_INPUT_MODIFIERS.filter(([bit]) => modifiers & bit).map(([, name]) => name);
  view.webContents.sendInputEvent({ type, keyCode, modifiers: names });
  if (text != null)
    view.webContents.sendInputEvent({ type: "char", keyCode: text, modifiers: names });
}

/** Chord input: press the chord's keys in order, then release the rest in reverse after the last key's down/up. */
export async function dispatchKeyPress(
  view: ControlledView,
  keys: readonly string[],
): Promise<void> {
  const normalized = keys
    .flatMap((key) => key.split("+"))
    .filter(Boolean)
    .map(normalizeCuaKey);
  const last = normalized.at(-1);
  if (!last) throw new Error("keypress requires at least one key");
  const held = normalized.slice(0, -1);
  const pressedModifiers = new Set<BrowserKeyModifier>();

  await withFocusedFrameSession(view, async (sessionId) => {
    const dispatch = async (type: "keyDown" | "keyUp", keyName: string): Promise<void> => {
      const modifier = asModifier(keyName);
      if (type === "keyDown" && modifier) pressedModifiers.add(modifier);
      if (type === "keyUp" && modifier) pressedModifiers.delete(modifier);
      await dispatchKeyEvent(
        view,
        type,
        keyName,
        modifiersBitmask([...pressedModifiers]),
        sessionId,
      );
    };
    for (const key of held) await dispatch("keyDown", key);
    await dispatch("keyDown", last);
    await dispatch("keyUp", last);
    for (const key of held.toReversed()) await dispatch("keyUp", key);
  });
}

/** Send one key press (keyDown + keyUp); the modifiers bitmask passes through, and sessionId targets a cross-process iframe. */
export async function dispatchKey(
  view: ControlledView,
  keyName: string,
  modifiers = 0,
  sessionId?: string,
): Promise<void> {
  const press = async (target: string | undefined) => {
    await dispatchKeyEvent(view, "keyDown", keyName, modifiers, target);
    await dispatchKeyEvent(view, "keyUp", keyName, modifiers, target);
  };
  if (sessionId != null) return press(sessionId);
  await withFocusedFrameSession(view, press);
}
