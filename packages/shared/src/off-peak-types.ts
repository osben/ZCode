import type { ZCodeTaskMode } from "./zcode-task-types-core.js";
import type { ModelSelection } from "./model-selection.js";

// ---- Off-Peak Task domain types ----
// off_peak_tasks is stored in tasks-index.sqlite.
// It shares the scheduler process and dispatch pipeline with automation, but its tables, message types, and state machine are independent.
// Do not add fields to ZCodeAutomation. SQLite columns use snake_case; these are cross-domain camelCase domain types.

/**
 * Six client execution states (server admission states queued/ready/active/expired/settled are a separate axis):
 * queued = waiting for server ready; paused = dispatch stopped by the user's Pause; running = executing;
 * permission/elicitation waits inside a regular session while the aggregate state remains running; completed/failed/cancelled are terminal.
 */
export type ZCodeOffPeakTaskStatus =
  | "queued"
  | "paused"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Terminal states: irreversible exits (state-machine invariant). */
export const OFF_PEAK_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export function isOffPeakTerminalStatus(
  status: ZCodeOffPeakTaskStatus,
): status is "completed" | "failed" | "cancelled" {
  return (OFF_PEAK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The expiry marker stays consistent across App/CLI; the concrete ready/active reason stays in the original business error code. */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";

/** The server splits inactive missed-slot and run timeout into separate codes; both need Host settlement — never miss the active timeout. */
export function isOffPeakTicketExpiredCode(code: string | number | undefined): boolean {
  return code === "3102" || code === 3102 || code === "3106" || code === 3106;
}

/** Off-Peak Provider has the identity of the current account Family; tasks preserve the exact choice and never silently migrate across Families. */
export const OFF_PEAK_PROVIDER_IDS = {
  zai: "account:zai-offpeak-idle-plan",
  bigmodel: "account:bigmodel-offpeak-idle-plan",
} as const;

export function resolveOffPeakProviderId(
  family: "zai" | "bigmodel",
): (typeof OFF_PEAK_PROVIDER_IDS)[typeof family] {
  return OFF_PEAK_PROVIDER_IDS[family];
}

/** Actual Coding Plan shape available for Off-Peak use on the currently selected connection. */
// Keep zai/bigmodel Team Plan variants symmetric by adding the zai-team kind.
export type OffPeakCodingPlanKind =
  | "zai-personal"
  | "bigmodel-personal"
  | "bigmodel-team"
  | "zai-team";

/**
 * Redacted Coding Plan support boundary. The renderer consumes only this result and never reads the JWT/API key.
 * `connection_unavailable` covers a missing or disabled provider, expiration, and an invalid Team runtime key;
 * none of these cases may fall back to another cached connection.
 */
export type OffPeakCodingPlanUnsupportedReason =
  | "provider_family_unselected"
  | "provider_family_api_key_mode"
  | "provider_identity_mismatch"
  | "connection_unselected"
  | "start_plan_not_supported"
  | "connection_unavailable"
  | "selection_changed"
  | "jwt_missing";

export type OffPeakCodingPlanSupport =
  | {
      supported: true;
      kind: OffPeakCodingPlanKind;
      providerFamily: "zai" | "bigmodel";
      providerId: string;
    }
  | {
      supported: false;
      reason: OffPeakCodingPlanUnsupportedReason;
    };

/**
 * Current snapshot of the server's ticket quota.
 * Used only to determine whether a new ticket can be requested; POST /ticket remains the final admission authority.
 */
export interface OffPeakTakeNumberAvailability {
  canTakeNumber: boolean;
  /** Earliest time the server says ticket requests can resume, in Unix milliseconds. */
  nextTakeAt?: number;
}

export function isOffPeakTicketExpiredError(message: string | undefined): boolean {
  return Boolean(message?.includes(OFF_PEAK_TICKET_EXPIRED_MARKER));
}

/** One off-peak task: form creation requests a ticket and queues it; dispatch creates a new session through createTask. */
export interface ZCodeOffPeakTask {
  projectId?: string | null;
  hostId?: string;
  /** Frozen when the definition is created; later edits to the virtual project roots do not affect it. */
  additionalDirectories?: string[];
  /** Local primary key, also used as the server task_id (stable, spans multiple tickets, D26). */
  offPeakTaskId: string;
  /** Snowflake ticket_id returned by the server; updated whenever a new ticket is requested (resume after 3h expiry / Continue retry). */
  serverTicketId?: string;
  /** Task title from the form. */
  title: string;
  /** Host conversation taskId, filled after the first successful dispatch (form: create a session; in-session: bind the session's first run); non-empty means it has run. */
  conversationId?: string;
  /**
   * Execution session. Filled after the first run for form-created tasks; in-session tasks store the current session ID at creation,
   * then resume that session on the first run instead of creating one. Also used to resume the same session on continuation/recovery.
   */
  sessionId?: string;
  /** Current title of the bound session (read-only derived value joined from tasks-index when listing; not persisted). */
  sessionTitle?: string;
  /** Instructions from the form. */
  prompt: string;
  /** Four fully open permission levels mapped to the existing ZCodeTaskMode; defaults to "default" (Ask for approval). */
  permissionMode: ZCodeTaskMode;
  /**
   * Structured Submission selection fixed when creation is accepted.
   *
   * Older database records may contain only model/thought_level, so this is temporarily empty on read. Keep these tasks available for user
   * repair, but do not schedule them until the full Selection is restored.
   */
  modelSelection?: ModelSelection;
  /** Read-only diagnostic fact when Selection cannot be reliably recovered from an older record. */
  modelSelectionIssue?: {
    code: "repair-required";
    legacyModelId?: string;
    legacyReasoningLevel?: string;
  };
  /** workspaceIdentity?.trim() || workspacePath */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  status: ZCodeOffPeakTaskStatus;
  /** FIFO ordering basis (the server's authoritative order is determined by ticket request order; locally used only for display/dispatch sorting). */
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  failureReason?: string;
  /** Completion notification and status bar display; populated from the existing task diff. */
  filesChanged?: number;
  /** Server acknowledgment time for terminal-state settlement; undefined means unsettled and reported by the outbox. */
  settledAt?: number;
  /**
   * Time when the user deleted the local History row.
   * Controls History visibility only; does not delete the task/session or clear any execution fields.
   */
  historyDeletedAt?: number;
  // -- Server sync snapshot (written by host offPeakTaskSync and read cross-process by the scheduler) --
  /** Successful ticket request time (POST /ticket acknowledgment); undefined means no ticket was requested. */
  registeredAt?: number;
  /** Server ready (coarse gate): true = off-peak window is open and a ticket is available, so the scheduler may claim and dispatch. */
  schedulable?: boolean;
  /** Queue position, shown in the UI as "#N in queue". */
  queuePosition?: number;
  /** Next polling time (interval supplied by the server as next_poll_after). */
  nextPollAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Input for creating an off-peak task (workspace is injected by the caller from context; the service requests a ticket first and persists only on success). */
export interface ZCodeOffPeakTaskCreateParams {
  projectId?: string | null;
  hostId?: string;
  /** Frozen when the definition is created; later edits to the virtual project roots do not affect it. */
  additionalDirectories?: string[];
  title: string;
  prompt: string;
  permissionMode: ZCodeTaskMode;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
  /** In-session creation: bind to the current session and resume it on the first run (matching CronCreate targetTaskId). Omitted for form creation. */
  boundSessionId?: string;
}

/** Stable ticket state returned at the creation boundary; values match server ticket states, but the server ticket ID is not exposed. */
export type OffPeakTaskTicketInitialState =
  | "queued"
  | "ready"
  | "active"
  | "expired"
  | "settled"
  | "not_found";

export type OffPeakTaskCreateFailureStage =
  | "client_validation"
  | "ticket_request"
  | "local_persist";

export type OffPeakTaskCreateErrorCategory =
  | "client_validation"
  | "eligibility_3101"
  | "quota_3103"
  | "network"
  | "invalid_response"
  | "local_persist"
  | "unknown";

/**
 * Discriminated union for the creation RPC. Failures retain only stable categories/business codes; raw errors and response bodies must not cross RPC.
 * providerName is narrowed on the Host side to an explicitly safe hostname; full URLs are not allowed.
 */
export type OffPeakTaskCreateResult =
  | {
      ok: true;
      task: ZCodeOffPeakTask;
      ticketInitialState: OffPeakTaskTicketInitialState;
      queuePosition?: number;
      providerName: string;
    }
  | {
      ok: false;
      failureStage: OffPeakTaskCreateFailureStage;
      errorCategory: OffPeakTaskCreateErrorCategory;
      errorCode: string;
      providerName: string;
    };
