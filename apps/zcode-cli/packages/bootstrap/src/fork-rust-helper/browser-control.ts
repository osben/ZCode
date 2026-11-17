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

interface ChildRegistration {
  parentSessionId: string;
  port: BrowserControlPort;
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
