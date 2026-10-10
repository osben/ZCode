/* Client for the five off-peak server endpoints.
   Handles only the JSON endpoints for quota snapshots, ticket acquisition, batch status checks,
   and settlement. Model messages do not go through this client; the idle plan per-turn provider
   connects directly from the agent process.
   There are no built-in retries; queueing and backoff are handled by callers
   (offPeakTaskService polling and the adapter layer). */
import { z } from "zod";
import type { OffPeakTakeNumberAvailability } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  withRequestIdHeader,
  REQUEST_ID_HEADER_NAME,
} from "#src/providers/api/requestIdHeaders.js";
import { buildZCodeSourceHeaders } from "#src/providers/sourceHeaders.js";
import {
  buildOffPeakPlanIdentityHeaders,
  type OffPeakCredentialSnapshot,
} from "./offPeakRuntimeModel.js";

/** Server admission state (the server axis of the two-axis state machine). */
export const offPeakTicketStateSchema = z.enum([
  "queued",
  "ready",
  "active",
  "expired",
  "settled",
  "not_found",
]);
export type OffPeakTicketState = z.infer<typeof offPeakTicketStateSchema>;

// Response fields use the server v2 snake_case format; parse loosely and ignore unknown fields.
// ⚠ next_poll_after is in seconds (following the Retry-After convention).
const takeTicketResponseSchema = z
  .object({
    ticket_id: z.string().min(1),
    task_id: z.string().optional(),
    state: offPeakTicketStateSchema,
    accepted: z.boolean().optional(),
    // The server returns a number only in the queued state and explicitly returns null for states such as ready/active;
    // accept null here and normalize it to an omitted field in the domain model so one parse failure does not interrupt the entire status sync.
    position: z.number().int().nonnegative().nullish(),
    next_poll_after: z.number().nonnegative().optional(),
    queued_at: z.number().optional(),
    ready_deadline: z.number().optional(),
  })
  .passthrough();

const ticketStatusEntrySchema = z
  .object({
    ticket_id: z.string().min(1),
    task_id: z.string().optional(),
    state: offPeakTicketStateSchema,
    position: z.number().int().nonnegative().nullish(),
    active_deadline: z.number().optional(),
  })
  .passthrough();

const batchStatusResponseSchema = z
  .object({
    next_poll_after: z.number().nonnegative().optional(),
    tickets: z.array(ticketStatusEntrySchema).default([]),
  })
  .passthrough();

const settleResponseSchema = z
  .object({
    ticket_id: z.string().min(1).optional(),
    task_id: z.string().optional(),
    state: z.string().optional(),
    settled_at: z.number().optional(),
  })
  .passthrough();

const takeNumberAvailabilityResponseSchema = z
  .object({
    can_take_number: z.boolean(),
    next_take_at: z.number().int().positive().optional(),
  })
  .passthrough();

/** Business error body (best-effort parsing for non-2xx HTTP responses; follows the Z.AI gateway code/msg convention and tolerates missing fields). */
const errorBodySchema = z
  .object({
    code: z.number().optional(),
    msg: z.string().optional(),
    message: z.string().optional(),
    next_take_at: z.number().optional(),
    data: z
      .object({ next_take_at: z.number().int().positive().optional() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export interface OffPeakTakeTicketResult {
  ticketId: string;
  state: OffPeakTicketState;
  position?: number;
  /** Delay before the next poll in milliseconds; server seconds have already been converted. */
  nextPollAfterMs?: number;
  registeredAt: number;
}

export interface OffPeakTicketStatusEntry {
  ticketId: string;
  state: OffPeakTicketState;
  position?: number;
  activeDeadline?: number;
}

export interface OffPeakBatchStatusResult {
  nextPollAfterMs?: number;
  tickets: OffPeakTicketStatusEntry[];
}

/** Typed server error: callers branch on bizCode (3101 not eligible / 3103 ticket limit exceeded / other). */
export class OffPeakServerError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly bizCode?: number,
    readonly nextTakeAt?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "OffPeakServerError";
  }
}

interface OffPeakServerClientDeps {
  /** API origin (real server or mock gateway; ZCODE_OFFPEAK_MOCK is selected during assembly); async is allowed because the mock gateway starts lazily. */
  resolveOrigin: () => string | Promise<string>;
  /** Credential snapshot: all four ticket endpoints use the same selected credential snapshot. */
  resolveCredentials: () => Promise<OffPeakCredentialSnapshot>;
  fetchImpl?: typeof fetch;
  logger: ServiceLogger;
}

const REQUEST_TIMEOUT_MS = 10_000;

export interface OffPeakServerClient {
  getTakeNumberAvailability(): Promise<OffPeakTakeNumberAvailability>;
  takeTicket(taskId: string): Promise<OffPeakTakeTicketResult>;
  batchStatus(ticketIds: string[]): Promise<OffPeakBatchStatusResult>;
  settle(ticketId: string): Promise<void>;
}

export function createOffPeakServerClient(deps: OffPeakServerClientDeps): OffPeakServerClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const credentials = await deps.resolveCredentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const origin = await deps.resolveOrigin();
      // This client uses fetch directly and previously bypassed NodeApiClient source-header and request-ID injection;
      // the test server could see only user_agent=node, and client logs could not be correlated with server requests returning 2007/bare 429.
      // Add only standard non-sensitive source headers and the trace ID here; JWT/API keys must still never enter logs.
      const headers = withRequestIdHeader({
        ...buildZCodeSourceHeaders(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        authorization: `Bearer ${credentials.jwt}`,
        "x-coding-plan-api-key": credentials.codingPlanApiKey,
        ...buildOffPeakPlanIdentityHeaders(credentials),
      });
      const response = await fetchImpl(`${origin}/api/v1/off-peak${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      const json: unknown = text ? safeJsonParse(text) : {};
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(json);
        const errorBody = parsed.success ? parsed.data : {};
        const requestId =
          response.headers.get(REQUEST_ID_HEADER_NAME)?.trim() ||
          headers.get(REQUEST_ID_HEADER_NAME)?.trim() ||
          undefined;
        // Use warn for recoverable server rejections; record contract metadata only, never raw credentials, fingerprints, or response bodies.
        deps.logger.warn(undefined, "off-peak request rejected", {
          bizCode: errorBody.code,
          credentialKind: credentials.kind,
          httpStatus: response.status,
          method,
          path,
          requestId,
        });
        throw new OffPeakServerError(
          `off-peak ${path} failed: HTTP ${response.status}${errorBody.code ? ` code=${errorBody.code}` : ""}${(errorBody.msg ?? errorBody.message) ? ` ${errorBody.msg ?? errorBody.message}` : ""}`,
          response.status,
          errorBody.code,
          errorBody.next_take_at ?? errorBody.data?.next_take_at,
          requestId,
        );
      }
      // Support both bare responses and {code:0,data} envelopes (v2 docs specify bare responses; gateway conventions may wrap them).
      if (
        json &&
        typeof json === "object" &&
        "data" in json &&
        (json as { code?: number }).code === 0
      ) {
        return (json as { data: unknown }).data;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getTakeNumberAvailability() {
      const raw = await request("GET", "/ticket/availability");
      const parsed = takeNumberAvailabilityResponseSchema.parse(raw);
      // A false snapshot without a recovery time prevents the UI from scheduling another check and can leave it disabled permanently.
      // The contract requires next_take_at when false; treat malformed responses as query failures so the UI can fail open and POST /ticket can serve as fallback.
      if (!parsed.can_take_number && parsed.next_take_at === undefined) {
        throw new Error("off-peak availability missing next_take_at while unavailable");
      }
      return {
        canTakeNumber: parsed.can_take_number,
        ...(parsed.next_take_at !== undefined ? { nextTakeAt: parsed.next_take_at } : {}),
      };
    },
    async takeTicket(taskId) {
      const raw = await request("POST", "/ticket", { task_id: taskId });
      const parsed = takeTicketResponseSchema.parse(raw);
      deps.logger.info(
        undefined,
        `off-peak take ticket ok task=${taskId} ticket=${parsed.ticket_id} state=${parsed.state} position=${parsed.position ?? "-"}`,
      );
      return {
        ticketId: parsed.ticket_id,
        state: parsed.state,
        ...(parsed.position != null ? { position: parsed.position } : {}),
        ...(parsed.next_poll_after !== undefined
          ? { nextPollAfterMs: parsed.next_poll_after * 1000 }
          : {}),
        registeredAt: Date.now(),
      };
    },
    async batchStatus(ticketIds) {
      if (ticketIds.length === 0) return { tickets: [] };
      // The contract limit is ≤100; listNonTerminal callers use far fewer, so truncate and warn instead of splitting the response.
      // The server's ticket limit is reached well before a user can have 100 nonterminal tasks.
      const limited = ticketIds.slice(0, 100);
      if (limited.length < ticketIds.length) {
        deps.logger.warn(`off-peak batch status truncated ${ticketIds.length} -> 100`);
      }
      const raw = await request("POST", "/ticket/status", {
        ticket_ids: limited,
      });
      const parsed = batchStatusResponseSchema.parse(raw);
      return {
        ...(parsed.next_poll_after !== undefined
          ? { nextPollAfterMs: parsed.next_poll_after * 1000 }
          : {}),
        tickets: parsed.tickets.map((entry) => ({
          ticketId: entry.ticket_id,
          state: entry.state,
          ...(entry.position != null ? { position: entry.position } : {}),
          ...(entry.active_deadline !== undefined ? { activeDeadline: entry.active_deadline } : {}),
        })),
      };
    },
    async settle(ticketId) {
      // Idempotent: duplicate reports and unknown tickets always return 2xx with no body.
      const raw = await request("POST", `/ticket/${encodeURIComponent(ticketId)}/settle`);
      settleResponseSchema.parse(raw);
      deps.logger.info(undefined, `off-peak settle acked ticket=${ticketId}`);
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
