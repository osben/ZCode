/**
 * Public types of the ACP agent runtime.
 *
 * The runtime drives one external ACP agent (e.g. `opencode acp`,
 * `cursor-agent acp`) over JSON-RPC stdio and surfaces a small typed event
 * stream for the host application.
 */
import type { ContentBlock, StopReason } from "@agentclientprotocol/sdk";

/** Launch definition of one external ACP agent process. */
export interface AcpLaunchOptions {
  /** Stable agent identifier (e.g. "opencode", "cursor", "mock"). */
  readonly agentId: string;
  /** Executable name (resolved via PATH) or absolute path. */
  readonly command: string;
  /** CLI arguments, e.g. ["acp"]. */
  readonly args: readonly string[];
  /** Explicit child environment overrides; `undefined` deletes a key. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Absolute working directory for the agent process and its session. */
  readonly cwd: string;
}

/** Deadline overrides (tests, embedding hosts). */
export interface AcpTimeouts {
  readonly initializeMs?: number;
  readonly newSessionMs?: number;
  readonly cancelGraceMs?: number;
  readonly stopGraceMs?: number;
  readonly killGraceMs?: number;
  /** Emit a `stalled` event when a prompt produces no frames for this long; 0 disables. */
  readonly stallWarningMs?: number;
}

export type AcpRuntimeState = "starting" | "ready" | "prompting" | "stopped" | "failed";

export interface AcpAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface AcpToolCallInfo {
  readonly toolCallId: string;
  readonly title: string;
  readonly kind?: string | null;
  readonly status?: string | null;
  readonly raw: unknown;
}

export interface AcpPlanEntry {
  readonly content: string;
  readonly priority: string;
  readonly status: string;
}

/** Typed event stream emitted by the runtime (`on("event", ...)`). */
export type AcpRuntimeEvent =
  | { readonly type: "message_chunk"; readonly text: string }
  | { readonly type: "thought_chunk"; readonly text: string }
  | { readonly type: "tool_call"; readonly toolCall: AcpToolCallInfo }
  | { readonly type: "tool_call_update"; readonly toolCall: AcpToolCallInfo }
  | { readonly type: "plan"; readonly entries: readonly AcpPlanEntry[]; readonly raw: unknown }
  | {
      readonly type: "usage";
      readonly used?: number;
      readonly size?: number;
      readonly cost?: unknown;
      readonly raw: unknown;
    }
  | { readonly type: "session_title"; readonly title: string }
  | { readonly type: "available_commands"; readonly commands: readonly unknown[] }
  | { readonly type: "auth_required"; readonly methods: readonly AcpAuthMethod[] }
  | { readonly type: "stopped"; readonly reason: StopReason; readonly usage?: unknown }
  | { readonly type: "stalled"; readonly silentMs: number }
  | { readonly type: "process_cleanup_failed"; readonly message: string }
  | {
      readonly type: "process_exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

export interface AcpPermissionOptionInfo {
  readonly optionId: string;
  readonly kind: string;
  readonly name: string;
}

export interface AcpPermissionAsk {
  /** Unique, runtime-generated correlation id. */
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly title: string;
  /** Human-readable detail extracted from the tool call content, if any. */
  readonly detail: string | null;
  readonly options: readonly AcpPermissionOptionInfo[];
  readonly raw: unknown;
}

export type AcpPermissionAnswerKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

/**
 * Host answer for a permission ask. The answer names the intended `kind`
 * (never an agent-specific `optionId`); the runtime maps it onto the matching
 * option of the current request.
 */
export type AcpPermissionAnswer =
  | { readonly outcome: "selected"; readonly kind: AcpPermissionAnswerKind }
  | { readonly outcome: "cancelled" };

export interface AcpFsBridge {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

/** Direction of a raw NDJSON frame observed on the wire. */
export type AcpFrameDirection = "inbound" | "outbound";

/** One raw NDJSON line observed at the transport boundary. */
export interface AcpRawFrame {
  readonly direction: AcpFrameDirection;
  /**
   * The line without its trailing LF. Lines over 16 KiB are truncated to
   * their first 16 KiB (cut at a UTF-8 boundary) plus the marker
   * `"…[truncated]"`.
   */
  readonly text: string;
  /** True when the line exceeded the 16 KiB observer cap and `text` is truncated. */
  readonly truncated: boolean;
}

/**
 * Observer for raw NDJSON wire traffic. Called once per line, per direction,
 * in wire order; observer exceptions are swallowed and never affect the
 * runtime.
 */
export type AcpFrameObserver = (frame: AcpRawFrame) => void;

/** Host callbacks the runtime uses to talk back to the application. */
export interface AcpHostBridge {
  /**
   * Ask the host to resolve a `session/request_permission` prompt.
   * When omitted (or when it rejects), the runtime answers `cancelled`.
   */
  requestPermission?(ask: AcpPermissionAsk): Promise<AcpPermissionAnswer>;
  /** Called with the auth methods advertised by the agent, when present. */
  onAuthMethods?(methods: readonly AcpAuthMethod[]): void;
  /** When provided, the runtime advertises fs capabilities and routes file I/O through it. */
  fs?: AcpFsBridge;
}

export type { ContentBlock, StopReason };
