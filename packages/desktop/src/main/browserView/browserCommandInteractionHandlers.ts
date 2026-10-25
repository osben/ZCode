import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
import { browserSnapshotElementSchema } from "@zcode/shared";
import {
  dispatchClickAt,
  dispatchDrag,
  dispatchDragPath,
  dispatchKey,
  dispatchKeyPress,
  dispatchScrollGesture,
  modifiersBitmask,
  resolveRefCenter,
} from "./browserCommandInput.js";
import { CHECK_SCRIPT, ELEMENT_AT_POINT_SCRIPT, SELECT_SCRIPT } from "./browserCommandScripts.js";
import { readState } from "./browserCommandState.js";
import type { BrowserPoint, ControlledView } from "./browserCommandTypes.js";
import type { BrowserCommandDone } from "./browserCommandResult.js";
import { executionError, refNotFound } from "./browserCommandResult.js";
import { pasteTextIntoFocusedTarget } from "./browserVirtualClipboard.js";

export async function handleClick(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "click" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // Use either a ref or coordinates (x,y): refs go through resolveRefCenter (the script already
  // calls scrollIntoView); (x,y) are used directly as viewport coordinates.
  const center = await resolveCommandPoint(view, command, "click");
  if (center.kind === "error") return done(center.error);
  await dispatchClickAt(
    view,
    center.point,
    command.button ?? "left",
    command.doubleClick === true,
    modifiersBitmask(command.modifiers),
  );
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleType(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "type" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // When ref is supplied, click it first to focus. During input, resolve the focused frame again
  // inside the specified guest so the Electron embedder's composer autofocus cannot steal app focus
  // between click/type and receive the page text.
  if (command.ref) {
    const center = await resolveRefCenter(view, command.ref);
    if (!center) return done(refNotFound(command.ref));
    await dispatchClickAt(view, center, "left", false);
  }
  await pasteTextIntoFocusedTarget(view, command.text);
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handlePress(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "press" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // When ref is supplied, click it to focus, then send keyDown+keyUp according to KEY_MAP (pass through the modifiers bitmask).
  if (command.ref) {
    const center = await resolveRefCenter(view, command.ref);
    if (!center) return done(refNotFound(command.ref));
    await dispatchClickAt(view, center, "left", false);
  }
  await dispatchKey(view, command.key, modifiersBitmask(command.modifiers));
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleCuaKeypress(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "cuaKeypress" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  await dispatchKeyPress(view, command.keys);
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleScroll(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "scroll" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // With a ref, reuse resolveRefCenter (the script already calls scrollIntoView(block:'center')).
  // Otherwise, use x/y as scroll increments with position fixed at (0,0), applying deltaX/deltaY.
  if (command.ref) {
    const center = await resolveRefCenter(view, command.ref);
    if (!center) return done(refNotFound(command.ref));
    return done({ ok: true, state: readState(view.webContents) });
  }
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 0,
    y: 0,
    deltaX: command.x ?? 0,
    deltaY: command.y ?? 0,
  });
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleCuaScroll(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "cuaScroll" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  await dispatchScrollGesture(
    view,
    { cx: command.x, cy: command.y },
    command.scrollX,
    command.scrollY,
    modifiersBitmask(command.modifiers),
  );
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleDomCuaScroll(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "domCuaScroll" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  let point: BrowserPoint | null;
  if (command.nodeId) {
    point = await resolveRefCenter(view, command.nodeId);
    if (!point) return done(refNotFound(command.nodeId));
  } else {
    const metrics = (await view.cdp.send("Page.getLayoutMetrics")) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const width = metrics.cssVisualViewport?.clientWidth;
    const height = metrics.cssVisualViewport?.clientHeight;
    if (typeof width !== "number" || typeof height !== "number") {
      return done(executionError("Page.getLayoutMetrics returned no cssVisualViewport"));
    }
    point = { cx: width / 2, cy: height / 2 };
  }
  await dispatchScrollGesture(view, point, command.scrollX, command.scrollY);
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleHover(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "hover" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // ref (through resolveRefCenter) or (x,y) → CDP mouseMoved to trigger hover state.
  const center = await resolveCommandPoint(view, command, "hover");
  if (center.kind === "error") return done(center.error);
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.point.cx,
    y: center.point.cy,
    ...(modifiersBitmask(command.modifiers) > 0
      ? { modifiers: modifiersBitmask(command.modifiers) }
      : {}),
  });
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleSelect(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "select" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // Set the <select>'s selected state in the page by values (match value exactly first, then visible text) and dispatch input+change.
  const raw = (await view.webContents.executeJavaScript(
    SELECT_SCRIPT(command.ref, command.values),
  )) as { ok?: boolean; error?: string } | null;
  if (!raw || typeof raw !== "object")
    return done(executionError("select returned invalid result"));
  if (raw.error === "ref_not_found") return done(refNotFound(command.ref));
  if (raw.error === "not_select") {
    return done(executionError(`element ${command.ref} is not a <select>`));
  }
  if (raw.error === "no_match") {
    return done(executionError(`no <option> matched values ${JSON.stringify(command.values)}`));
  }
  if (raw.error) return done(executionError(`select failed: ${raw.error}`));
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleCheck(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "check" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // Set the checkbox/radio referenced by ref to checked (default true); dispatch a native click only when the state must change.
  const raw = (await view.webContents.executeJavaScript(
    CHECK_SCRIPT(command.ref, command.checked ?? true),
  )) as { ok?: boolean; error?: string } | null;
  if (!raw || typeof raw !== "object") return done(executionError("check returned invalid result"));
  if (raw.error === "ref_not_found") return done(refNotFound(command.ref));
  if (raw.error === "not_checkable") {
    return done(executionError(`element ${command.ref} is not a checkbox/radio`));
  }
  if (raw.error) return done(executionError(`check failed: ${raw.error}`));
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleDrag(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "drag" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // Start = fromRef or from{x,y}; end = toRef or to{x,y} → synthesize a mouse-drag sequence through CDP.
  const from = await resolveDragPoint(view, command.fromRef, command.from, "from");
  if (from.kind === "error") return done(from.error);
  const to = await resolveDragPoint(view, command.toRef, command.to, "to");
  if (to.kind === "error") return done(to.error);
  await dispatchDrag(view, from.point, to.point, modifiersBitmask(command.modifiers));
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleCuaDrag(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "cuaDrag" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  await dispatchDragPath(view, command.path, modifiersBitmask(command.modifiers));
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleElementInfo(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "elementInfo" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // Viewport coordinates (x,y) → document.elementFromPoint → reuse the snapshot element shape (assign a ref and store it in __zcodeRefs).
  const raw = await view.webContents.executeJavaScript(
    ELEMENT_AT_POINT_SCRIPT(command.x, command.y),
  );
  if (raw == null) {
    // No element was hit: return ok:true but omit element.
    return done({ ok: true });
  }
  const parsed = browserSnapshotElementSchema.safeParse(raw);
  if (!parsed.success) {
    return done(
      executionError(
        `invalid element result shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      ),
    );
  }
  return done({ ok: true, element: parsed.data });
}

async function resolveCommandPoint(
  view: ControlledView,
  command: { ref?: string; x?: number; y?: number },
  label: "click" | "hover",
): Promise<
  | { kind: "ok"; point: BrowserPoint }
  | { kind: "error"; error: Omit<BrowserCommandResult, "elapsedMs"> }
> {
  if (command.ref) {
    const point = await resolveRefCenter(view, command.ref);
    if (!point) return { kind: "error", error: refNotFound(command.ref) };
    return { kind: "ok", point };
  }
  if (typeof command.x === "number" && typeof command.y === "number") {
    return { kind: "ok", point: { cx: command.x, cy: command.y } };
  }
  return { kind: "error", error: executionError(`${label} requires ref or (x,y)`) };
}

async function resolveDragPoint(
  view: ControlledView,
  ref: string | undefined,
  point: { x: number; y: number } | undefined,
  label: "from" | "to",
): Promise<
  | { kind: "ok"; point: BrowserPoint }
  | { kind: "error"; error: Omit<BrowserCommandResult, "elapsedMs"> }
> {
  if (ref) {
    const center = await resolveRefCenter(view, ref);
    if (!center) return { kind: "error", error: refNotFound(ref) };
    return { kind: "ok", point: center };
  }
  if (point) return { kind: "ok", point: { cx: point.x, cy: point.y } };
  return { kind: "error", error: executionError(`drag requires ${label}Ref or ${label}{x,y}`) };
}
