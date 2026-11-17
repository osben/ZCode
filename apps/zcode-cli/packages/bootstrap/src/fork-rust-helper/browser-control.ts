// Fork F4b (specs/fork-rust-node-helper.md "F4b browser broker", F4-D5, F4-D7): the helper's browser control. It reuses
// Node's broker (zcode-protocol/browser-control-broker.ts) unchanged. Child-session facts come only from Rust.
import { z } from "zod";
import type { BrowserControlPort, Logger, McpServerConfig } from "@zcode/contracts";
import { createProtocolBrowserControlBroker } from "../zcode-protocol/browser-control-broker.js";
import { ProtocolRequestError, type ZCodeProtocolAgentServerContext } from "../zcode-protocol/server-types.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "../app/node-repl-browser-broker.js";

export const FORK_RUST_HELPER_BROWSER_CHILD_SESSION = "helper/browser/childSession";
export const FORK_RUST_HELPER_BROWSER_CHILD_SESSION_END = "helper/browser/childSessionEnd";
/** Rust ended a turn: the broker's turnEnded (F4-D5). */
export const FORK_RUST_HELPER_TURN_ENDED = "helper/turn/ended";
/** Rust asks for the end-of-turn screenshot of a turn with a browser candidate (D2-H). */
export const FORK_RUST_HELPER_BROWSER_TURN_SCREENSHOT = "helper/browser/turnScreenshot";
/** Rust's turn was cancelled during the capture: the helper aborts that capture's broker calls (D2 C1). */
export const FORK_RUST_HELPER_BROWSER_TURN_SCREENSHOT_CANCEL = "helper/browser/turnScreenshotCancel";

/** Strict wire shapes (F4-D7). Unknown keys are refused. */
export const childSessionParamsSchema = z
  .object({
    childSessionId: z.string().trim().min(1),
    parentSessionId: z.string().trim().min(1),
    tabOwner: z.literal("parent"),
  })
  .strict();
export const childSessionEndParamsSchema = z
  .object({ childSessionId: z.string().trim().min(1) })
  .strict();

export type ChildSessionParams = z.infer<typeof childSessionParamsSchema>;

export const turnScreenshotParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    turnId: z.string().trim().min(1),
    browserId: z.string().trim().min(1),
    browserGeneration: z.number().int(),
  })
  .strict();
export type TurnScreenshotParams = z.infer<typeof turnScreenshotParamsSchema>;

/** The turn key of a capture, derived from the capture's params so the two shapes cannot drift (strict is kept). */
export const turnScreenshotCancelParamsSchema = turnScreenshotParamsSchema.pick({
  sessionId: true,
  turnId: true,
});

/** One display image, as Node's browser command result carries it. */
export interface TurnScreenshotImage {
  base64: string;
  mimeType: string;
}

interface ChildRegistration {
  parentSessionId: string;
  port: BrowserControlPort;
}

/** The key of one end-of-turn capture: a turn has at most one in flight per session. */
function captureKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

/**
 * node_repl's config with the broker's socket and token in its env (Node `injectNodeReplBrowserBroker`). Every path that
 * connects node_repl (a session open, a pipe) goes through here, so the pool sees one config and starts one process.
 */
export function nodeReplConfigFor(
  browser: ForkRustBrowserControl,
  server: string,
  config: McpServerConfig,
): McpServerConfig {
  if (server !== "node_repl") return config;
  return injectNodeReplBrowserBroker({ [server]: config }, browser.nodeRepl())[server] ?? config;
}

/** The helper's browser control: one Node broker, its node_repl socket, and the child registrations it owns. */
export class ForkRustBrowserControl {
  /** Node's broker port: the state machine of the browser scopes (shared by the node_repl socket and lifecycle). */
  readonly port: BrowserControlPort;
  private readonly children = new Map<string, ChildRegistration>();
  /** The end-of-turn captures in flight, by session and turn: a cancel from Rust aborts one (D2 C1). */
  private readonly captures = new Map<string, AbortController>();
  private nodeReplBroker: NodeReplBrowserBroker | undefined;

  constructor(
    private readonly deps: { context: ZCodeProtocolAgentServerContext; logger?: Logger },
  ) {
    this.port = createProtocolBrowserControlBroker(deps.context);
  }

  /** The node_repl broker, created on first use: its socket and token go into node_repl's env. */
  nodeRepl(): NodeReplBrowserBroker {
    this.nodeReplBroker ??= createNodeReplBrowserBroker({
      browserControlPort: this.port,
      logger: this.deps.logger ?? noopLogger,
    });
    return this.nodeReplBroker;
  }

  /**
   * `helper/browser/childSession`: registers a subagent under its parent (Node `forChildSession`). A duplicate with the
   * same parent is a no-op; a different parent refuses it.
   */
  childSession(params: unknown): void {
    const parsed = childSessionParamsSchema.safeParse(params);
    if (!parsed.success) throw new ProtocolRequestError(-32602, "Invalid helper/browser/childSession params");
    const { childSessionId, parentSessionId } = parsed.data;
    const existing = this.children.get(childSessionId);
    if (existing) {
      if (existing.parentSessionId === parentSessionId) return;
      throw new ProtocolRequestError(
        -32602,
        `Child session is registered to another parent: ${childSessionId}`,
      );
    }
    const port = this.port.forChildSession?.({
      childSessionId,
      parentSessionId,
      tabOwner: "parent",
    });
    if (!port) throw new ProtocolRequestError(-32602, "The browser broker cannot register child sessions");
    this.children.set(childSessionId, { parentSessionId, port });
  }

  /** `helper/browser/childSessionEnd`: releases one registration. An unknown id is logged and ignored. */
  async childSessionEnd(params: unknown): Promise<void> {
    const parsed = childSessionEndParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.deps.logger?.warn("Refused helper/browser/childSessionEnd params", {
        event: "fork_rust_helper.browser.child_end_refused",
      });
      return;
    }
    const { childSessionId } = parsed.data;
    const registration = this.children.get(childSessionId);
    if (!registration) {
      this.deps.logger?.debug("Child session end for an unknown id", {
        event: "fork_rust_helper.browser.child_end_unknown",
      });
      return;
    }
    this.children.delete(childSessionId);
    await registration.port.closeSession?.({ sessionId: childSessionId }).catch((error: unknown) => {
      this.deps.logger?.warn("Child session browser release failed", {
        event: "fork_rust_helper.browser.child_end_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * `helper/browser/turnScreenshot` (D2-H): Node's appendBrowserTurnScreenshot capture. Lists the tabs, screenshots the
   * active one through the session's broker port (the child registration's port for a subagent), and answers the
   * image. A missing active tab, a refused screenshot or a broker failure answers `{}` and is logged; the turn is not
   * failed by it, as Node swallows the same failures.
   */
  async turnScreenshot(params: TurnScreenshotParams): Promise<{ image?: TurnScreenshotImage }> {
    const port = this.children.get(params.sessionId)?.port ?? this.port;
    const key = captureKey(params.sessionId, params.turnId);
    const controller = new AbortController();
    this.captures.set(key, controller);
    const target = {
      browserId: params.browserId,
      browserGeneration: params.browserGeneration,
      sessionId: params.sessionId,
      turnId: params.turnId,
      // Node passes turnAbortSignal to both calls: an abort makes the broker send cancelRequest to Main.
      signal: controller.signal,
    };
    try {
      const listed = await port.execute({ ...target, command: { method: "list" } });
      const active = listed.ok ? listed.tabs?.find((tab) => tab.active === true) : undefined;
      if (!active) {
        this.deps.logger?.debug("Browser turn screenshot skipped because no active tab is available", {
          event: "fork_rust_helper.browser.turn_screenshot_skipped",
        });
        return {};
      }
      const captured = await port.execute({
        ...target,
        command: { method: "screenshot", tabId: active.tabId },
      });
      if (!captured.ok || !captured.image) {
        this.deps.logger?.warn("Browser turn screenshot capture returned no image", {
          event: "fork_rust_helper.browser.turn_screenshot_failed",
        });
        return {};
      }
      return { image: captured.image };
    } catch (error) {
      // An abort is Rust's cancel of the turn (D2 C1), a routine outcome of an interrupt rather than a broker failure.
      if (controller.signal.aborted) {
        this.deps.logger?.debug("Browser turn screenshot cancelled with the turn", {
          event: "fork_rust_helper.browser.turn_screenshot_cancelled",
        });
        return {};
      }
      this.deps.logger?.warn("Browser turn screenshot failed", {
        event: "fork_rust_helper.browser.turn_screenshot_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    } finally {
      if (this.captures.get(key) === controller) this.captures.delete(key);
    }
  }

  /**
   * `helper/browser/turnScreenshotCancel` (D2 C1): Rust's turn was cancelled during the capture. Aborts the capture in
   * flight, if any; a capture that already answered has no entry and nothing happens.
   */
  cancelTurnScreenshot(sessionId: string, turnId: string): void {
    this.captures.get(captureKey(sessionId, turnId))?.abort();
  }

  /** The broker's `turnEnded` for a session (`helper/turn/ended`). */
  async turnEnded(sessionId: string, turnId: string): Promise<void> {
    await this.port.turnEnded?.({ sessionId, turnId });
  }

  /** The broker's `closeSession` for a session, run before its MCP lease closes. */
  async closeSession(sessionId: string): Promise<void> {
    await this.port.closeSession?.({ sessionId });
  }

  async dispose(): Promise<void> {
    await this.nodeReplBroker?.close();
    this.nodeReplBroker = undefined;
    this.children.clear();
  }
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
} as unknown as Logger;
