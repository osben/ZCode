/* eslint-disable max-lines -- Keep the BrowserCommand Zod discriminated union as one runtime source of truth; splitting it could make protocol methods and schemas drift. */
import { z } from "zod";
import { browserViewportInputSchema } from "./command-metadata.js";

export {
  browserClientModeSchema,
  browserCommandContextSchema,
  browserCommandMethodSchema,
  browserErrorCodeSchema,
  browserPageStateSchema,
} from "./command-metadata.js";
export type {
  BrowserClientMode,
  BrowserCommandContext,
  BrowserCommandMethod,
  BrowserErrorCode,
  BrowserPageState,
} from "./command-metadata.js";

export const browserMouseButtonSchema = z.enum(["left", "right", "middle"]);
export type BrowserMouseButton = z.infer<typeof browserMouseButtonSchema>;

/** Keyboard modifiers; the executor maps these to the modifiers bitmask used by CDP dispatchMouse/KeyEvent. */
export const browserKeyModifierSchema = z.enum([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);
export type BrowserKeyModifier = z.infer<typeof browserKeyModifierSchema>;

/** Viewport coordinate point (used by the CUA coordinate path / elementInfo / drag; same coordinate system as CDP Input). */
export const browserPointSchema = z.object({ x: z.number(), y: z.number() }).strict();
export type BrowserPoint = z.infer<typeof browserPointSchema>;

const browserRecordingDurationSchema = z.number().int().nonnegative().max(90_000);
const browserRecordingSelectorSchema = z.string().trim().min(1).max(2_000);

/** Built-in WebView recording accepts only a restricted action DSL; it cannot be used to execute arbitrary page scripts. */
export const browserRecordingActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), durationMs: browserRecordingDurationSchema }).strict(),
  z
    .object({
      type: z.literal("click"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("type"),
      selector: browserRecordingSelectorSchema,
      text: z.string().max(100_000),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hover"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      x: z.number(),
      y: z.number(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      deltaX: z.number().optional(),
      deltaY: z.number(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scrollTo"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wheel"),
      deltaX: z.number().optional(),
      deltaY: z.number(),
      times: z.number().int().min(1).max(100).optional(),
      intervalMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      path: z.array(browserPointSchema).min(2).max(200),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("waitFor"),
      selector: browserRecordingSelectorSchema,
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
]);
export type BrowserRecordingAction = z.infer<typeof browserRecordingActionSchema>;

export const browserRecordingOptionsSchema = z
  .object({
    viewport: browserViewportInputSchema.optional(),
    fps: z.number().int().min(1).max(60).optional(),
    jpegQuality: z.number().int().min(1).max(100).optional(),
    maxDurationMs: z.number().int().min(1_000).max(90_000).optional(),
    settleMs: browserRecordingDurationSchema.optional(),
    showCursor: z.boolean().optional(),
    actions: z.array(browserRecordingActionSchema).max(500).optional(),
  })
  .strict();
export type BrowserRecordingOptions = z.infer<typeof browserRecordingOptionsSchema>;

const browserRecordingOutputPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => !/^[/\\]/u.test(value) && !/^[A-Za-z]:[/\\]/u.test(value), {
    message: "recording outputPath must be relative to the workspace",
  })
  .refine(
    (value) =>
      !value
        .split(/[\\/]+/u)
        .some((segment) => segment === ".." || segment === "." || segment.length === 0),
    { message: "recording outputPath cannot escape the workspace" },
  )
  .refine((value) => value.toLowerCase().endsWith(".webm"), {
    message: "recording outputPath must end with .webm",
  });

/** Playwright locator terminal operations that can cross processes. The builder composes selectors only within the Agent. */
export const browserPlaywrightLocatorOperationSchema = z.enum([
  "allTextContents",
  "click",
  "count",
  "dblclick",
  "downloadMedia",
  "evaluate",
  "fill",
  "getAttribute",
  "innerText",
  "isEnabled",
  "isVisible",
  "press",
  "selectOption",
  "setChecked",
  "textContent",
  "waitFor",
]);
export type BrowserPlaywrightLocatorOperation = z.infer<
  typeof browserPlaywrightLocatorOperationSchema
>;

export const browserPlaywrightModifierSchema = z.enum([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);
export type BrowserPlaywrightModifier = z.infer<typeof browserPlaywrightModifierSchema>;

const browserPlaywrightTimeoutSchema = z.number().int().positive().optional();
const browserPlaywrightSelectOptionSchema = z
  .object({
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (selection) =>
      selection.value !== undefined ||
      selection.label !== undefined ||
      selection.index !== undefined,
    "Select option requires value, label, or index",
  );

/**
 * Public Playwright operations use a backend-independent message shape, distinguishing actions by `name` and `operation`,
 * so extensions/CDP adapters can reuse the same contract.
 */
export const browserPlaywrightActionSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("domSnapshot") }).strict(),
  z
    .object({
      name: z.literal("elementInfo"),
      x: z.number(),
      y: z.number(),
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("elementScreenshot"),
      x: z.number(),
      y: z.number(),
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("evaluate"),
      expression: z.string().min(1),
      expressionKind: z.enum(["string", "function"]),
      arg: z.unknown().optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForLoadState"),
      state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForURL"),
      url: z.string().min(1),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForEvent"),
      event: z.enum(["download", "filechooser"]),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("downloadPath"),
      downloadId: z.string().min(1),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("fileChooserSetFiles"),
      fileChooserId: z.string().min(1),
      files: z.array(z.string()).min(1),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("locator"),
      selector: z.string().min(1),
      operation: browserPlaywrightLocatorOperationSchema,
      value: z.unknown().optional(),
      arg: z.unknown().optional(),
      expression: z.string().min(1).optional(),
      expressionKind: z.enum(["string", "function"]).optional(),
      attribute: z.string().min(1).optional(),
      checked: z.boolean().optional(),
      replace: z.boolean().optional(),
      force: z.boolean().optional(),
      button: browserMouseButtonSchema.optional(),
      modifiers: z.array(browserPlaywrightModifierSchema).optional(),
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      selections: z.array(browserPlaywrightSelectOptionSchema).min(1).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
]);
export type BrowserPlaywrightAction = z.infer<typeof browserPlaywrightActionSchema>;

/**
 * Unified command surface: backends recognize only this discriminated union.
 *
 * Optional tabId: the Agent object model uses it to address a specific controlled tab (including tabs opened by a human).
 * If omitted, the command targets the session's default view. The manager resolves the controlled-view key as `command.tabId ?? key`.
 */
export const browserCommandSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("navigate"),
      url: z.string().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("back"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("forward"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("reload"), tabId: z.string().optional() }).strict(),
  z
    .object({
      method: z.literal("snapshot"),
      maxElements: z.number().int().positive().optional(),
      includeHidden: z.boolean().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("click"),
      // Choose either ref (a snapshot handle) or coordinates (x,y): ref uses dom_cua-style targeting; (x,y) uses CUA visual-coordinate targeting.
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("fill"),
      ref: z.string().min(1),
      value: z.string(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("type"),
      ref: z.string().min(1).optional(),
      text: z.string(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("press"),
      key: z.string().min(1),
      ref: z.string().min(1).optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA chord input: keys represent one chord; preserve each key's down/up order instead of reducing it to the final key plus a bitmask.
  z
    .object({
      method: z.literal("cuaKeypress"),
      keys: z.array(z.string().min(1)).min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("scroll"),
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA scroll input: the viewport anchor and scroll delta are separate coordinate values; modifiers may also be included.
  z
    .object({
      method: z.literal("cuaScroll"),
      x: z.number(),
      y: z.number(),
      scrollX: z.number(),
      scrollY: z.number(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // DOM CUA scroll input: scroll from the viewport center when nodeId is omitted, or from the node center when provided.
  z
    .object({
      method: z.literal("domCuaScroll"),
      nodeId: z.string().min(1).optional(),
      scrollX: z.number(),
      scrollY: z.number(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("screenshot"),
      ref: z.string().min(1).optional(),
      fullPage: z.boolean().optional(),
      // Region screenshot: the clip for CDP Page.captureScreenshot (viewport CSS pixels); mutually exclusive with fullPage.
      clip: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .strict()
        .optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("getState"), tabId: z.string().optional() }).strict(),
  // hover: move the pointer to an element (ref) or coordinates (x,y) to trigger hover (CUA move / DOM CUA targeting followed by move).
  z
    .object({
      method: z.literal("hover"),
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // select: choose one or more options in a <select> (matching by value or visible text).
  z
    .object({
      method: z.literal("select"),
      ref: z.string().min(1),
      values: z.array(z.string()).min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // check: set a checkbox/radio checked state (checked defaults to true).
  z
    .object({
      method: z.literal("check"),
      ref: z.string().min(1),
      checked: z.boolean().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // drag: drag from a start point (fromRef or from{x,y}) to an end point (toRef or to{x,y}) using CDP Input mouse synthesis.
  z
    .object({
      method: z.literal("drag"),
      fromRef: z.string().min(1).optional(),
      toRef: z.string().min(1).optional(),
      from: browserPointSchema.optional(),
      to: browserPointSchema.optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA drag input: the full path is part of the public contract; backends must send every point, not only the endpoints.
  z
    .object({
      method: z.literal("cuaDrag"),
      path: z.array(browserPointSchema).min(1),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // elementInfo: given viewport coordinates (x,y), look up the hit element's information (role/name/rect/selector), bridging visual and structural access.
  z
    .object({
      method: z.literal("elementInfo"),
      x: z.number(),
      y: z.number(),
      tabId: z.string().optional(),
    })
    .strict(),
  // evaluate: execute a JavaScript expression in the page context and return a JSON-serializable result.
  z
    .object({
      method: z.literal("evaluate"),
      expression: z.string().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // getDialog: read the current JavaScript dialog (alert/confirm/prompt/beforeunload), or return dialog=null if none is open.
  z.object({ method: z.literal("getDialog"), tabId: z.string().optional() }).strict(),
  // handleDialog: accept or dismiss the current JavaScript dialog; prompt may include promptText.
  z
    .object({
      method: z.literal("handleDialog"),
      accept: z.boolean(),
      promptText: z.string().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("waitFor"),
      selector: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      textGone: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // PlaywrightAPI.waitForTimeout: fixed waits accept only nonnegative integers; 0 yields one timer tick.
  z
    .object({
      method: z.literal("playwrightWaitForTimeout"),
      timeoutMs: z.number().int().nonnegative(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("playwright"),
      action: browserPlaywrightActionSchema,
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("capabilities"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("browserVisibilityGet") }).strict(),
  z.object({ method: z.literal("browserVisibilitySet"), visible: z.boolean() }).strict(),
  browserViewportInputSchema
    .extend({
      method: z.literal("browserViewportSet"),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("browserViewportReset"), tabId: z.string().optional() }).strict(),
  z
    .object({
      method: z.literal("recordingStart"),
      options: browserRecordingOptionsSchema.optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("recordingStatus"),
      recordingId: z.string().trim().min(1),
      outputPath: browserRecordingOutputPathSchema.optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("recordingCancel"),
      recordingId: z.string().trim().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // Backend activation step for tabs.get(id): validate and update the selected tab for that scope; the renderer decides whether to show it or record it in the background.
  z.object({ method: z.literal("activateTab"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("newTab") }).strict(),
  z.object({ method: z.literal("listUserTabs") }).strict(),
  z.object({ method: z.literal("claimTab"), tabId: z.string().min(1) }).strict(),
  z
    .object({
      method: z.literal("finalizeTabs"),
      keep: z.array(
        z.object({ tabId: z.string().min(1), status: z.enum(["handoff", "deliverable"]) }).strict(),
      ),
    })
    .strict(),
  z.object({ method: z.literal("markDeliverable"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("markHandoff"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("nameSession"), name: z.string().trim().min(1) }).strict(),
  z
    .object({
      method: z.literal("finalize"),
      tabId: z.string().optional(),
      deliverable: z.boolean().optional(),
    })
    .strict(),
  z.object({ method: z.literal("turnEnded"), turnId: z.string().min(1).optional() }).strict(),
  z.object({ method: z.literal("closeSession") }).strict(),
  z.object({ method: z.literal("cancelRequest"), requestId: z.string().min(1) }).strict(),
  // close: close the specified controlled tab (tabId defaults to the current tab). The manager detaches it and tells the renderer to unload the webview.
  z.object({ method: z.literal("close"), tabId: z.string().optional() }).strict(),
  // list: enumerate controlled-tab summaries for the current session window. The manager intercepts it and returns result.tabs.
  z.object({ method: z.literal("list") }).strict(),
]);
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
