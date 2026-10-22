/**
 * Browser-safe contract types for the ACP agents bridge.
 *
 * These types are re-exported from the `@zcode/services` entry point, so this
 * module must stay free of Node.js imports; the implementation lives in
 * `acpAgents.ts`.
 */

/** One raw NDJSON frame observed on an agent's stdio. */
export interface AcpFrameEvent {
  readonly direction: "out" | "in";
  readonly text: string;
  readonly at: number;
}

/** One known agent with detection facts and settings-relevant commands. */
export interface AcpAgentSummary {
  readonly agentId: string;
  readonly displayName: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly commandPath: string | null;
  readonly spawnArgs: readonly string[];
  readonly loginArgs: readonly string[];
  readonly statusArgs: readonly string[] | null;
}

export interface AcpAgentDetectionResult {
  /** False when this environment cannot run ACP agents at all. */
  readonly supported: boolean;
  readonly agents: readonly AcpAgentSummary[];
  readonly detectedAt: number;
}

export interface AcpAgentTestInput {
  /** Known agent id (`opencode`, `cursor`); used for defaults when `command` is absent. */
  readonly agentId?: string;
  /** Explicit executable path/name override (custom agent configuration). */
  readonly command?: string;
  /** Explicit spawn arguments override; defaults to the definition's ACP arguments. */
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface AcpAgentTestResult {
  readonly ok: boolean;
  readonly error?: { readonly message: string };
  /** Raw NDJSON frames in capture order; bounded by the host implementation. */
  readonly frames: readonly AcpFrameEvent[];
  /** Frames observed after the capture bound but dropped; count only. */
  readonly framesDropped: number;
  readonly stderrTail?: string;
  readonly durationMs: number;
}

export interface AcpAgentStatusReport {
  readonly supported: boolean;
  readonly exitCode?: number | null;
  readonly output?: string;
  readonly error?: string;
}

export interface AcpAgentLoginResult {
  readonly opened: boolean;
  /** The exact command that was launched (or should be run manually). */
  readonly command: string;
  readonly error?: string;
}

/** Settings-facing surface, threaded through the provider settings service. */
export interface ProviderSettingsAcpAgentsBridge {
  detect(input?: { readonly refresh?: boolean }): Promise<AcpAgentDetectionResult>;
  test(input: AcpAgentTestInput): Promise<AcpAgentTestResult>;
  status(input: AcpAgentStatusInput): Promise<AcpAgentStatusReport>;
  startLogin(input: AcpAgentLoginInput): Promise<AcpAgentLoginResult>;
}

export interface AcpAgentStatusInput {
  readonly agentId: string;
  /** Configured executable override (the enabled provider's saved command). */
  readonly command?: string;
}

export interface AcpAgentLoginInput {
  readonly agentId: string;
  /** Configured executable override (the enabled provider's saved command). */
  readonly command?: string;
}

/**
 * Enable or edit one agent. The record lives in the fork-owned sidecar store and is exposed as
 * the derived personal provider `acp:<agentId>` (specs/acp-agent-runtime.md "Storage and
 * upstream compatibility").
 */
export interface AcpAgentSaveInput {
  readonly agentId: string;
  readonly providerName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly enabled: boolean;
}

export interface AcpAgentEnabledInput {
  readonly agentId: string;
  readonly enabled: boolean;
}

/** Host-side writer of the ACP agent records; absent when the host has no sidecar store. */
export interface ProviderSettingsAcpAgentWriter {
  save(input: AcpAgentSaveInput): Promise<void>;
  setEnabled(input: AcpAgentEnabledInput): Promise<void>;
}
