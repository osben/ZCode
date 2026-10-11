import type { TraceContext } from "../tracing/tracer.js";

/**
 * BrowserControlPort: browser-control port on the agent side.
 *
 * The browser-client library turns each agent.browsers.* call into a BrowserCommand and
 * executes it through this port. The implementation (ProtocolBrowserControlBroker) converts
 * it into a ZCode Protocol interaction/browserExecute reverse request, executed by the app
 * (host → main WebContentsView/CDP).
 *
 * Type note: BrowserCommand/BrowserCommandResult mirror the browser-use contract in
 * @zcode/shared. Define structural copies here (without importing @zcode/shared) to avoid
 * coupling agent contracts' zod v3 to shared's zod v4. The protocol boundary uses shared's
 * zod schema for runtime validation, and round-trip tests ensure both sides stay consistent.
 */

/** Playwright is a Tab API layer, not a backend family. */
export type BrowserBackendType = "iab" | "extension" | "cdp";

export interface BrowserCapabilityDescriptor {
  id: string;
  description: string;
}

/**
 * Backend descriptor for a completed handshake that is actually reachable; `id` is the
 * runtime connection identity and cannot be replaced by `type`.
 */
export interface BrowserBackendDescriptor {
  id: string;
  generation: number;
  type: BrowserBackendType;
  name: string;
  capabilities: {
    browser?: BrowserCapabilityDescriptor[];
    tab?: BrowserCapabilityDescriptor[];
  };
  apiSupportOverrides?: Record<string, boolean>;
  metadata?: Record<string, string>;
}

/** ZCode Protocol uses a wrapped result; BrowserControlPort.list unwraps it and returns browsers directly. */
export interface BrowserBackendListResult {
  browsers: BrowserBackendDescriptor[];
}

export type BrowserClientMode = "desktop-continuous" | "web-remote-replayable";
export type BrowserSessionContextKind = "live" | "cached";

/** Uses the same CSS pixel bounds as the Desktop free-size viewport. */
export const BROWSER_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
} as const;

export interface BrowserViewportSize {
  width: number;
  height: number;
}

/** Complete workspace/session isolation context used for backend discovery. */
export interface BrowserDiscoveryContext {
  requestId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  turnId?: string;
  clientMode: BrowserClientMode;
  sessionContext: BrowserSessionContextKind;
}

/** execute adds an exact runtime browser identity to discovery context. */
export interface BrowserSessionContext extends BrowserDiscoveryContext {
  browserId: string;
  browserGeneration: number;
}

export type BrowserCommandMethod =
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "snapshot"
  | "click"
  | "fill"
  | "type"
  | "press"
  | "cuaKeypress"
  | "scroll"
  | "cuaScroll"
  | "domCuaScroll"
  | "hover"
  | "select"
  | "check"
  | "drag"
  | "cuaDrag"
  | "screenshot"
  | "getState"
  | "elementInfo"
  | "evaluate"
  | "getDialog"
  | "handleDialog"
  | "waitFor"
  | "playwright"
  | "playwrightWaitForTimeout"
  | "capabilities"
  | "browserVisibilityGet"
  | "browserVisibilitySet"
  | "browserViewportSet"
  | "browserViewportReset"
  | "recordingStart"
  | "recordingStatus"
  | "recordingCancel"
  | "activateTab"
  | "newTab"
  | "finalize"
  | "finalizeTabs"
  | "listUserTabs"
  | "claimTab"
  | "markDeliverable"
  | "markHandoff"
  | "nameSession"
  | "turnEnded"
  | "closeSession"
  | "cancelRequest"
  | "close"
  | "list";

export type BrowserMouseButton = "left" | "right" | "middle";
export type BrowserKeyModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";
export type BrowserPlaywrightModifier = BrowserKeyModifier;
export type BrowserPlaywrightLocatorOperation =
  | "allTextContents"
  | "click"
  | "count"
  | "dblclick"
  | "downloadMedia"
  | "evaluate"
  | "fill"
  | "getAttribute"
  | "innerText"
  | "isEnabled"
  | "isVisible"
  | "press"
  | "selectOption"
  | "setChecked"
  | "textContent"
  | "waitFor";
export type BrowserPlaywrightAction =
  | { name: "domSnapshot" }
  | { name: "elementInfo"; x: number; y: number; includeNonInteractable?: boolean }
  | { name: "elementScreenshot"; x: number; y: number; includeNonInteractable?: boolean }
  | {
      name: "evaluate";
      expression: string;
      expressionKind: "string" | "function";
      arg?: unknown;
      timeoutMs?: number;
    }
  | {
      name: "waitForLoadState";
      state?: "load" | "domcontentloaded" | "networkidle";
      timeoutMs?: number;
    }
  | {
      name: "waitForURL";
      url: string;
      waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
      timeoutMs?: number;
    }
  | { name: "waitForEvent"; event: "download" | "filechooser"; timeoutMs?: number }
  | { name: "downloadPath"; downloadId: string; timeoutMs?: number }
  | {
      name: "fileChooserSetFiles";
      fileChooserId: string;
      files: string[];
      timeoutMs?: number;
    }
  | {
      name: "locator";
      selector: string;
      operation: BrowserPlaywrightLocatorOperation;
      value?: unknown;
      arg?: unknown;
      expression?: string;
      expressionKind?: "string" | "function";
      attribute?: string;
      checked?: boolean;
      replace?: boolean;
      force?: boolean;
      button?: BrowserMouseButton;
      modifiers?: BrowserPlaywrightModifier[];
      state?: "attached" | "detached" | "visible" | "hidden";
      selections?: Array<{ value?: string; label?: string; index?: number }>;
      timeoutMs?: number;
    };
export interface BrowserPoint {
  x: number;
  y: number;
}

export type BrowserRecordingAction =
  | { type: "wait"; durationMs: number }
  | {
      type: "click";
      selector?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      delayAfterMs?: number;
    }
  | { type: "type"; selector: string; text: string; delayAfterMs?: number }
  | {
      type: "hover";
      selector?: string;
      x?: number;
      y?: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | { type: "move"; x: number; y: number; durationMs?: number; delayAfterMs?: number }
  | {
      type: "scroll";
      deltaX?: number;
      deltaY: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | {
      type: "scrollTo";
      selector?: string;
      x?: number;
      y?: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | {
      type: "wheel";
      deltaX?: number;
      deltaY: number;
      times?: number;
      intervalMs?: number;
      delayAfterMs?: number;
    }
  | { type: "drag"; path: BrowserPoint[]; durationMs?: number; delayAfterMs?: number }
  | {
      type: "waitFor";
      selector: string;
      state?: "attached" | "detached" | "visible" | "hidden";
      timeoutMs?: number;
      delayAfterMs?: number;
    };

export interface BrowserRecordingOptions {
  viewport?: BrowserViewportSize;
  fps?: number;
  jpegQuality?: number;
  maxDurationMs?: number;
  settleMs?: number;
  showCursor?: boolean;
  actions?: BrowserRecordingAction[];
}

// Optional tabId: the agent object model uses it to address a specific controlled tab
// (including a tab opened by a human); when omitted, the session's default view is used.
// Keep each variant structurally in sync with @zcode/shared's browserCommandSchema.
export type BrowserCommand =
  | { method: "navigate"; url: string; tabId?: string }
  | { method: "back"; tabId?: string }
  | { method: "forward"; tabId?: string }
  | { method: "reload"; tabId?: string }
  | { method: "snapshot"; maxElements?: number; includeHidden?: boolean; tabId?: string }
  | {
      method: "click";
      ref?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "fill"; ref: string; value: string; tabId?: string }
  | { method: "type"; ref?: string; text: string; tabId?: string }
  | { method: "press"; key: string; ref?: string; modifiers?: BrowserKeyModifier[]; tabId?: string }
  | { method: "cuaKeypress"; keys: string[]; tabId?: string }
  | { method: "scroll"; ref?: string; x?: number; y?: number; tabId?: string }
  | {
      method: "cuaScroll";
      x: number;
      y: number;
      scrollX: number;
      scrollY: number;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "domCuaScroll"; nodeId?: string; scrollX: number; scrollY: number; tabId?: string }
  | {
      method: "hover";
      ref?: string;
      x?: number;
      y?: number;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "select"; ref: string; values: string[]; tabId?: string }
  | { method: "check"; ref: string; checked?: boolean; tabId?: string }
  | {
      method: "drag";
      fromRef?: string;
      toRef?: string;
      from?: BrowserPoint;
      to?: BrowserPoint;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | {
      method: "cuaDrag";
      path: BrowserPoint[];
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | {
      method: "screenshot";
      ref?: string;
      fullPage?: boolean;
      clip?: { x: number; y: number; width: number; height: number };
      tabId?: string;
    }
  | { method: "getState"; tabId?: string }
  | { method: "elementInfo"; x: number; y: number; tabId?: string }
  | { method: "evaluate"; expression: string; tabId?: string }
  | { method: "getDialog"; tabId?: string }
  | { method: "handleDialog"; accept: boolean; promptText?: string; tabId?: string }
  | {
      method: "waitFor";
      selector?: string;
      text?: string;
      textGone?: string;
      timeoutMs?: number;
      tabId?: string;
    }
  | { method: "playwrightWaitForTimeout"; timeoutMs: number; tabId?: string }
  | { method: "playwright"; action: BrowserPlaywrightAction; tabId?: string }
  | { method: "capabilities"; tabId?: string }
  | { method: "browserVisibilityGet" }
  | { method: "browserVisibilitySet"; visible: boolean }
  | { method: "browserViewportSet"; width: number; height: number; tabId?: string }
  | { method: "browserViewportReset"; tabId?: string }
  | { method: "recordingStart"; options?: BrowserRecordingOptions; tabId?: string }
  | {
      method: "recordingStatus";
      recordingId: string;
      outputPath?: string;
      tabId?: string;
    }
  | { method: "recordingCancel"; recordingId: string; tabId?: string }
  | { method: "activateTab"; tabId: string }
  | { method: "newTab" }
  | { method: "listUserTabs" }
  | { method: "claimTab"; tabId: string }
  | {
      method: "finalizeTabs";
      keep: Array<{ tabId: string; status: "handoff" | "deliverable" }>;
    }
  | { method: "markDeliverable"; tabId: string }
  | { method: "markHandoff"; tabId: string }
  | { method: "nameSession"; name: string }
  | { method: "finalize"; tabId?: string; deliverable?: boolean }
  | { method: "turnEnded"; turnId?: string }
  // closeTabs: close its tabs too, including tabs released back to this session. Only for sessions that will never reclaim them (DWF subagents).
  | { method: "closeSession"; closeTabs?: boolean }
  | { method: "cancelRequest"; requestId: string }
  // close: close the specified controlled tab; handled by the manager layer.
  | { method: "close"; tabId?: string }
  // list: enumerate summaries for all controlled tabs in the current session window; the
  // manager layer intercepts this and returns tabs.
  | { method: "list" };

export type BrowserErrorCode =
  | "backend_unavailable"
  | "capability_unsupported"
  | "duplicate_request_id"
  | "ref_not_found"
  | "navigation_blocked"
  | "timeout"
  | "renderer_unreachable"
  | "cancelled"
  | "execution_error";

export interface BrowserPageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  scrollX?: number;
  scrollY?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  selector: string;
  xpath: string;
  rect: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  parentRef?: string;
  framePath?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshotDomNode {
  tag: string;
  depth: number;
  inViewport: boolean;
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: BrowserSnapshotElement[];
  truncated: boolean;
  dom?: BrowserSnapshotDomNode[];
  domTruncated?: boolean;
}

/** Controlled-tab summary (returned by the list command); keep in sync with @zcode/shared's browserTabSummarySchema. */
export interface BrowserTabSummary {
  tabId: string;
  url: string;
  title: string;
  /** Guest's current actual CSS viewport; required for both normal and free-size modes. */
  viewport: BrowserViewportSize;
  /** Currently visible/active built-in browser tab; the agent uses it first to read the page the user is viewing. */
  active?: boolean;
  lifecycle?: "active" | "deliverable" | "handoff";
}

export interface BrowserUserTabInfo {
  id: string;
  lastOpened?: string;
  tabGroup?: string;
  title?: string;
  url?: string;
}

export interface BrowserResponseMeta {
  browserUse: true;
  backendType: BrowserBackendType;
  browserId: string;
  browserGeneration: number;
  openTabIds: string[];
  tabId?: string;
  currentUrl?: string;
  lifecycle?: "active" | "deliverable" | "handoff" | "closed";
}

/** JavaScript dialog information (returned by getDialog). */
export interface BrowserDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}

export interface BrowserRecordingArtifact {
  path: string;
  mimeType: "video/webm";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
}

export interface BrowserRecordingJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "preparing" | "capturing" | "finalizing" | "completed" | "failed" | "cancelled";
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingArtifact;
  error?: string;
}

export interface BrowserCommandResult {
  ok: boolean;
  state?: BrowserPageState;
  snapshot?: BrowserSnapshot;
  image?: { base64: string; mimeType: "image/png" };
  /** Returned by the list command: summaries of all controlled tabs in the current session window. */
  tabs?: BrowserTabSummary[];
  userTabs?: BrowserUserTabInfo[];
  tab?: BrowserTabSummary;
  /** Returned by evaluate: the page expression's JSON-serializable result. */
  value?: unknown;
  /** Returned by elementInfo: information about the element at the coordinates (omitted if none is hit). */
  element?: BrowserSnapshotElement;
  /** Returned by getDialog: current JavaScript dialog information, or null when there is no dialog. */
  dialog?: BrowserDialog | null;
  recording?: BrowserRecordingJob;
  error?: { code: BrowserErrorCode; message: string; sideEffect?: "none" | "uncertain" };
  meta?: BrowserResponseMeta;
  elapsedMs: number;
}

export interface BrowserControlExecuteInput {
  /** Exact runtime backend id; do not pass only the iab/extension/cdp family. */
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  command: BrowserCommand;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

export interface BrowserControlListInput {
  sessionId: string;
  turnId?: string;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

/** Tab ownership for a sub-session Browser request: the sub-session itself (DWF subagent) or its parent (core Agent subagent). */
export type BrowserChildSessionTabOwner = "child" | "parent";

export interface BrowserControlPort {
  /** Return only backends with a completed handshake and a reachable current context; do not fabricate stubs. */
  list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]>;
  execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult>;
  /** Cancel unfinished IAB requests for this turn when it ends; do not clear tabs across sessions. */
  turnEnded?(input: BrowserControlListInput): Promise<void>;
  /** Release the browser guest, pending requests, and lease when the session closes. */
  closeSession?(input: BrowserControlListInput): Promise<void>;
  /**
   * Derive a port for a sub-session unknown to the client: resolve workspace / clientMode from the session identified by parentSessionId.
   *
   * - `tabOwner: "child"` (default, DWF subagent): tabs belong to the sub-session's own sessionId;
   *   the derived port's closeSession closes its tabs and ends this registration.
   * - `tabOwner: "parent"` (core Agent subagent): rewrite the dispatched sessionId to the parent
   *   session, so the subagent and current conversation share tabs (the desktop uses this to expand
   *   the panel, and tabs.list shows all conversation tabs). The derived port's turnEnded / closeSession
   *   do not change desktop lifecycle; the parent session manages the tabs, and closeSession only ends registration.
   *
   * After registration ends, requests from this sub-session are rejected as if it had never been registered.
   *
   * If absent, the implementation does not validate sessionId against client sessions (for example,
   * CLI headless CDP), and sub-sessions use this port directly. See
   * apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, “Subagent sessions”.
   */
  forChildSession?(input: {
    childSessionId: string;
    parentSessionId: string;
    tabOwner?: BrowserChildSessionTabOwner;
  }): BrowserControlPort;
}
