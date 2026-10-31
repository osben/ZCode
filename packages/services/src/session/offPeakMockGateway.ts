/* eslint-disable max-lines -- the mock gateway simulates availability, ticket, status, settle, and messages in one place; splitting it would fragment the shared ticket state. */
/* In-process off-peak mock gateway.
   A local 127.0.0.1 http service fully simulates quota snapshot / ticketing / batch status / settle / messages.
   The real HTTP client and the idle plan provider only need their baseURL pointed at this gateway's origin —
   production code paths are identical to integration runs, and flipping the ZCODE_OFFPEAK_MOCK switch is
   enough (tech-design §10, step 3).

   ⚠ After admission, the messages endpoint proxies requests verbatim to the real model endpoint chosen by
   resolveUpstream() (usually the user's coding plan's anthropic-compatible endpoint) — mock mode runs the
   real model and billing goes through the user's own key; development/demo only, as documented.

   State machine (the server axis of D26's two axes):
   take → queued (FIFO position); status polling triggers promotion (polling is Promote):
   ticket older than readyDelayMs → ready (readyDeadline = +readyTtlMs); ready expiring without the first
   message → expired; first message admitted → active (activeDeadline = +activeMs);
   active expiring → expired and messages returns 400/3106; settle → settled (idempotent).
   Before admission, messages can inject N rounds of 429/3105 + Retry-After (fine-grained full-load valve, D24). */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ServiceLogger } from "../logger/serviceLogger.js";

export interface OffPeakMockGatewayOptions {
  /** Delay before promotion from queued to ready; defaults to 15s (to demonstrate off-peak waiting). */
  readyDelayMs?: number;
  /** Window to send the first message after ready; defaults to 5min. */
  readyTtlMs?: number;
  /** Hard cap on active; defaults to 3h (shrink it to demo the 400/3106 expiry close-out). */
  activeMs?: number;
  /** Number of 429/3105 responses before admitting each ticket; defaults to 0. */
  queue429Count?: number;
  /** Return 3103 (free quota exhausted) for the first N ticket requests, to verify retry remains possible after the error prompt; defaults to 0. */
  quotaExhaustedCount?: number;
  /** Duration for which availability and actual ticket requests remain unavailable; defaults to 0, used by E2E to verify the server snapshot disables the action. */
  availabilityBlockedMs?: number;
  /** Retry-After seconds for 429 responses; defaults to 5. */
  retryAfterS?: number;
  /** next_poll_after seconds returned by status/take; defaults to 5. */
  nextPollS?: number;
  /** messages script used only by deterministic E2E; unset in production and ordinary mock demonstrations. */
  scenario?: "foreground-subagents" | "capture" | "invalid-ticket";
}

export interface OffPeakMockGatewayDeps {
  logger: ServiceLogger;
  /**
   * Forwarding target for messages after admission: full messages URL + outbound headers (including upstream auth).
   * Return null to skip proxying and return a fixed Anthropic response directly (E2E/offline demo: the agent loop completes immediately
   * without a real model key).
   */
  resolveUpstream: () => Promise<{
    url: string;
    headers: Record<string, string>;
  } | null>;
}

interface MockTicket {
  ticketId: string;
  taskId: string;
  state: "queued" | "ready" | "active" | "expired" | "settled";
  takenAt: number;
  readyAt?: number;
  readyDeadline?: number;
  activeDeadline?: number;
  queue429Remaining: number;
  /** FIFO sequence number used to calculate position. */
  seq: number;
}

export function isOffPeakMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["ZCODE_OFFPEAK_MOCK"] === "1";
}

/** Override numeric options through environment variables (for live demonstrations; tests pass options directly). */
function readEnvOptions(env: NodeJS.ProcessEnv): OffPeakMockGatewayOptions {
  const num = (key: string): number | undefined => {
    const raw = env[key];
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const scenarioValue = env["ZCODE_OFFPEAK_MOCK_SCENARIO"];
  const scenario =
    scenarioValue === "foreground-subagents" ||
    scenarioValue === "capture" ||
    scenarioValue === "invalid-ticket"
      ? scenarioValue
      : undefined;
  return {
    ...(num("ZCODE_OFFPEAK_MOCK_READY_DELAY_MS") !== undefined
      ? { readyDelayMs: num("ZCODE_OFFPEAK_MOCK_READY_DELAY_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_READY_TTL_MS") !== undefined
      ? { readyTtlMs: num("ZCODE_OFFPEAK_MOCK_READY_TTL_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_ACTIVE_MS") !== undefined
      ? { activeMs: num("ZCODE_OFFPEAK_MOCK_ACTIVE_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT") !== undefined
      ? { queue429Count: num("ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_QUOTA_COUNT") !== undefined
      ? { quotaExhaustedCount: num("ZCODE_OFFPEAK_MOCK_QUOTA_COUNT") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS") !== undefined
      ? {
          availabilityBlockedMs: num("ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS"),
        }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_RETRY_AFTER_S") !== undefined
      ? { retryAfterS: num("ZCODE_OFFPEAK_MOCK_RETRY_AFTER_S") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_NEXT_POLL_S") !== undefined
      ? { nextPollS: num("ZCODE_OFFPEAK_MOCK_NEXT_POLL_S") }
      : {}),
    ...(scenario ? { scenario } : {}),
  };
}

interface OffPeakMockCapturedRequest {
  hasApiKey: boolean;
  hasAuthorization: boolean;
  hasCodingPlanApiKey: boolean;
  maxTokens?: number;
  model?: string;
  requestJson: unknown;
  stage: string;
  ticketId: string;
  organization?: string;
  project?: string;
}

export interface OffPeakMockGatewayHandle {
  origin: string;
  port: number;
  /** true = another host's gateway already owns the port, and this handle only points to it (close is a no-op). */
  external: boolean;
  close: () => Promise<void>;
}

/** Fixed port (overridable with ZCODE_OFFPEAK_MOCK_PORT): multiple windows/hosts share the same mock ticket state. */
const DEFAULT_MOCK_PORT = 45_197;

export async function startOffPeakMockGateway(
  deps: OffPeakMockGatewayDeps,
  options?: OffPeakMockGatewayOptions & { port?: number },
): Promise<OffPeakMockGatewayHandle> {
  const config = {
    readyDelayMs: 15_000,
    readyTtlMs: 5 * 60_000,
    activeMs: 3 * 60 * 60_000,
    queue429Count: 0,
    quotaExhaustedCount: 0,
    availabilityBlockedMs: 0,
    retryAfterS: 5,
    nextPollS: 5,
    ...readEnvOptions(process.env),
    ...options,
  };
  const tickets = new Map<string, MockTicket>();
  let quotaInjectionsRemaining = config.quotaExhaustedCount;
  const availabilityBlockedUntil = Date.now() + config.availabilityBlockedMs;
  /** taskId → latest ticket (requesting a new ticket for the same task_id invalidates the old one). */
  const latestByTask = new Map<string, string>();
  const capturedRequests: OffPeakMockCapturedRequest[] = [];
  let invalidTicketRequests = 0;
  let expireNextWake = false;
  let releaseBackground!: () => void;
  const backgroundBarrier = new Promise<void>((resolve) => {
    releaseBackground = resolve;
  });
  let seqCounter = 0;

  /** Lazily advance time-driven state (evaluated during polling/messages; no background timer). */
  function advance(ticket: MockTicket, now: number): void {
    if (ticket.state === "queued" && now - ticket.takenAt >= config.readyDelayMs) {
      ticket.state = "ready";
      ticket.readyAt = now;
      ticket.readyDeadline = now + config.readyTtlMs;
    }
    if (
      ticket.state === "ready" &&
      ticket.readyDeadline !== undefined &&
      now > ticket.readyDeadline
    ) {
      ticket.state = "expired";
    }
    if (
      ticket.state === "active" &&
      ticket.activeDeadline !== undefined &&
      now > ticket.activeDeadline
    ) {
      ticket.state = "expired";
    }
  }

  /** Queue position = number of active tickets ahead that have not yet been promoted. */
  function positionOf(ticket: MockTicket): number {
    let ahead = 0;
    for (const other of tickets.values()) {
      if (other.state === "queued" && other.seq < ticket.seq) ahead += 1;
    }
    return ahead + 1;
  }

  function json(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  async function handleTake(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readBody(req)) as { task_id?: string };
    const taskId = body.task_id;
    if (!taskId) {
      json(res, 400, { code: 3000, msg: "task_id required" });
      return;
    }
    const now = Date.now();
    if (now < availabilityBlockedUntil) {
      json(res, 429, {
        code: 3103,
        msg: "free tier limit reached",
        data: { next_take_at: availabilityBlockedUntil },
      });
      return;
    }
    if (quotaInjectionsRemaining > 0) {
      quotaInjectionsRemaining -= 1;
      json(res, 429, {
        code: 3103,
        msg: "free tier limit reached",
        data: { next_take_at: now + 60_000 },
      });
      return;
    }
    // Re-requesting a ticket for the same task_id invalidates the old ticket (the real server has already terminalized it naturally).
    const previous = latestByTask.get(taskId);
    if (previous) {
      const old = tickets.get(previous);
      if (old && (old.state === "queued" || old.state === "ready" || old.state === "active")) {
        old.state = "expired";
      }
    }
    seqCounter += 1;
    const ticket: MockTicket = {
      ticketId: `mock-ticket-${seqCounter}`,
      taskId,
      state: "queued",
      takenAt: now,
      queue429Remaining: config.queue429Count,
      seq: seqCounter,
    };
    // With readyDelayMs=0, the ticket is ready immediately (the off-peak queue is idle and promotes it directly).
    advance(ticket, now);
    tickets.set(ticket.ticketId, ticket);
    latestByTask.set(taskId, ticket.ticketId);
    deps.logger.info(
      `mock gateway take task=${taskId} ticket=${ticket.ticketId} state=${ticket.state}`,
    );
    json(res, 200, {
      ticket_id: ticket.ticketId,
      task_id: taskId,
      state: ticket.state,
      accepted: true,
      position: ticket.state === "queued" ? positionOf(ticket) : null,
      next_poll_after: config.nextPollS,
      queued_at: now,
      ...(ticket.readyDeadline ? { ready_deadline: ticket.readyDeadline } : {}),
    });
  }

  function handleAvailability(res: ServerResponse): void {
    const now = Date.now();
    json(res, 200, {
      can_take_number: now >= availabilityBlockedUntil,
      ...(now < availabilityBlockedUntil ? { next_take_at: availabilityBlockedUntil } : {}),
    });
  }

  async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readBody(req)) as { ticket_ids?: string[] };
    const ids = Array.isArray(body.ticket_ids) ? body.ticket_ids.slice(0, 100) : [];
    const now = Date.now();
    const entries = ids.map((id) => {
      const ticket = tickets.get(id);
      if (!ticket) return { ticket_id: id, state: "not_found" as const };
      advance(ticket, now);
      return {
        ticket_id: ticket.ticketId,
        task_id: ticket.taskId,
        state: ticket.state,
        position: ticket.state === "queued" ? positionOf(ticket) : null,
        ...(ticket.activeDeadline ? { active_deadline: ticket.activeDeadline } : {}),
      };
    });
    json(res, 200, { next_poll_after: config.nextPollS, tickets: entries });
  }

  function handleSettle(res: ServerResponse, ticketId: string): void {
    const ticket = tickets.get(ticketId);
    if (ticket) ticket.state = "settled";
    // Idempotent: unknown tickets also return 200.
    json(res, 200, {
      ticket_id: ticketId,
      state: "settled",
      settled_at: Date.now(),
    });
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ticketId = String(req.headers["x-off-peak-ticket-id"] ?? "");
    const ticket = tickets.get(ticketId);
    const now = Date.now();
    if (ticket) advance(ticket, now);
    if (!ticket || ticket.state === "settled" || ticket.state === "queued") {
      json(res, 400, { code: 3104, msg: "invalid off-peak ticket" });
      return;
    }
    if (ticket.state === "expired") {
      // Activated and non-activated expired tickets must use distinct codes per the new server contract; the mock must not mask a client that misses 3106.
      json(res, 400, {
        code: ticket.activeDeadline === undefined ? 3102 : 3106,
        msg:
          ticket.activeDeadline === undefined
            ? "off-peak ready window expired"
            : "off-peak active window expired",
      });
      return;
    }
    if (config.scenario === "invalid-ticket") {
      // Fault-injected run timeout; the real Host/CLI must end the task, not re-ticket or switch to an ordinary plan.
      invalidTicketRequests += 1;
      json(res, 400, { code: 3106, msg: "off-peak active window expired" });
      return;
    }
    if (ticket.queue429Remaining > 0) {
      ticket.queue429Remaining -= 1;
      json(
        res,
        429,
        { code: 3105, msg: "model concurrency saturated (mock)" },
        { "retry-after": String(config.retryAfterS) },
      );
      return;
    }
    if (ticket.state === "ready") {
      // The first message within 5 minutes of ready admits the ticket as active and starts the 3h window.
      ticket.state = "active";
      ticket.activeDeadline = now + config.activeMs;
      deps.logger.info(
        `mock gateway admitted ticket=${ticketId} activeDeadline=${ticket.activeDeadline}`,
      );
    }
    // Admitted: proxy unchanged to the real upstream (pass SSE through).
    const requestBody = await (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    })();
    const requestJson = parseMockRequestJson(requestBody);
    if (config.scenario === "foreground-subagents" || config.scenario === "capture") {
      const stage = classifyForegroundSubagentScenarioRequest(requestJson);
      const maxTokens = readRequestNumber(requestJson, "max_tokens");
      const model = readRequestString(requestJson, "model");
      capturedRequests.push({
        hasApiKey: Boolean(req.headers["x-api-key"]),
        hasAuthorization: Boolean(req.headers.authorization),
        hasCodingPlanApiKey: Boolean(req.headers["x-coding-plan-api-key"]),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(model ? { model } : {}),
        requestJson,
        stage,
        ticketId,
        ...(typeof req.headers["bigmodel-organization"] === "string"
          ? { organization: req.headers["bigmodel-organization"] }
          : {}),
        ...(typeof req.headers["bigmodel-project"] === "string"
          ? { project: req.headers["bigmodel-project"] }
          : {}),
      });
      if (expireNextWake && stage === "parent-wakeup") {
        expireNextWake = false;
        ticket.state = "expired";
        invalidTicketRequests++;
        capturedRequests[capturedRequests.length - 1]!.stage = "parent-wakeup-expired";
        json(res, 400, { code: 3106, msg: "off-peak active window expired" });
        return;
      }
      const scripted =
        config.scenario === "foreground-subagents"
          ? buildForegroundSubagentScenarioResponse(
              stage,
              (server.address() as { port: number }).port,
            )
          : null;
      if (scripted) {
        if (stage.startsWith("background-")) await backgroundBarrier;
        respondWithAnthropicMock(res, scripted, readRequestBoolean(requestJson, "stream"));
        return;
      }
    }
    let upstream: { url: string; headers: Record<string, string> } | null;
    try {
      upstream = await deps.resolveUpstream();
    } catch (error) {
      deps.logger.warn("mock gateway resolveUpstream failed:", error);
      upstream = null;
    }
    if (!upstream) {
      // Offline/E2E: return a fixed non-streaming Anthropic response so the agent loop immediately receives stop and finishes.
      json(res, 200, {
        id: "msg_offpeak_mock",
        type: "message",
        role: "assistant",
        model: "offpeak-mock",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Off-peak mock run completed." }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return;
    }
    try {
      const upstreamResponse = await fetch(upstream.url, {
        method: "POST",
        headers: {
          "content-type": String(req.headers["content-type"] ?? "application/json"),
          ...(req.headers["anthropic-version"]
            ? { "anthropic-version": String(req.headers["anthropic-version"]) }
            : {}),
          ...upstream.headers,
        },
        body: new Uint8Array(requestBody),
      });
      const responseHeaders: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, key) => {
        // Do not forward hop-by-hop headers.
        if (
          ["transfer-encoding", "connection", "content-length", "content-encoding"].includes(key)
        ) {
          return;
        }
        responseHeaders[key] = value;
      });
      res.writeHead(upstreamResponse.status, responseHeaders);
      if (!upstreamResponse.body) {
        res.end();
        return;
      }
      const reader = upstreamResponse.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (error) {
      deps.logger.warn("mock gateway upstream proxy failed:", error);
      json(res, 502, { code: 2001, msg: "mock upstream proxy failed" });
    }
  }

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    void (async () => {
      if (
        req.method === "GET" &&
        url === "/__e2e/off-peak/background-bash" &&
        config.scenario === "foreground-subagents"
      ) {
        capturedRequests.push({
          stage: "bash-started",
          requestJson: {},
          ticketId: "",
          hasApiKey: false,
          hasAuthorization: false,
          hasCodingPlanApiKey: false,
        });
        await backgroundBarrier;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("E2E_OFFPEAK_BACKGROUND_BASH_OK");
        return;
      }
      if (
        req.method === "POST" &&
        url === "/__e2e/off-peak/release-background" &&
        config.scenario === "foreground-subagents"
      ) {
        const input = (await readBody(req)) as { expireOnWake?: boolean };
        expireNextWake = input.expireOnWake === true;
        releaseBackground();
        json(res, 200, { released: true });
        return;
      }
      if (
        req.method === "GET" &&
        url === "/__e2e/off-peak/requests" &&
        (config.scenario === "foreground-subagents" ||
          config.scenario === "capture" ||
          config.scenario === "invalid-ticket")
      ) {
        json(res, 200, {
          invalidTicketRequests,
          issuedTicketCount: tickets.size,
          requests: capturedRequests,
        });
        return;
      }
      if (req.method === "GET" && url === "/api/v1/off-peak/ticket/availability") {
        handleAvailability(res);
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { msg: "method not allowed" });
        return;
      }
      if (url === "/api/v1/off-peak/ticket") {
        await handleTake(req, res);
        return;
      }
      if (url === "/api/v1/off-peak/ticket/status") {
        await handleStatus(req, res);
        return;
      }
      const settleMatch = /^\/api\/v1\/off-peak\/ticket\/([^/]+)\/settle$/.exec(url);
      if (settleMatch) {
        handleSettle(res, decodeURIComponent(settleMatch[1]!));
        return;
      }
      if (url === "/api/v1/off-peak/anthropic/v1/messages") {
        await handleMessages(req, res);
        return;
      }
      json(res, 404, { msg: `no mock route for ${url}` });
    })().catch((error) => {
      deps.logger.warn("mock gateway handler failed:", error);
      try {
        json(res, 500, { msg: "mock gateway internal error" });
      } catch {
        // The response has already been sent; ignore this.
      }
    });
  });

  const requestedPort =
    options?.port ??
    (Number(process.env["ZCODE_OFFPEAK_MOCK_PORT"]) > 0
      ? Number(process.env["ZCODE_OFFPEAK_MOCK_PORT"])
      : DEFAULT_MOCK_PORT);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // Multiple windows: another host already started the gateway, so share its ticket state (tickets move between hosts in shared SQLite;
      // mock state must be single-instance, or a ticket issued by host A cannot be found by host B).
      const origin = `http://127.0.0.1:${requestedPort}`;
      deps.logger.info(`off-peak mock gateway reusing existing instance at ${origin}`);
      return {
        origin,
        port: requestedPort,
        external: true,
        close: async () => {},
      };
    }
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("off-peak mock gateway failed to bind");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  deps.logger.info(`off-peak mock gateway listening at ${origin}`);
  return {
    origin,
    port: address.port,
    external: false,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const FOREGROUND_SUBAGENT_SCENARIO = {
  parentMarker: "E2E_OFFPEAK_SUBAGENTS_PARENT",
  parentFinal: "E2E_OFFPEAK_SUBAGENTS_PARENT_OK",
  children: [
    {
      stage: "child-explore",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE_OK",
      toolId: "toolu_e2e_offpeak_explore",
      input: {
        description: "Verify Explore foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE_OK.",
        subagent_type: "Explore",
      },
    },
    {
      stage: "child-general-purpose",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL_OK",
      toolId: "toolu_e2e_offpeak_general",
      input: {
        description: "Verify general-purpose foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL_OK.",
        subagent_type: "general-purpose",
      },
    },
    {
      stage: "child-code-search",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH_OK",
      toolId: "toolu_e2e_offpeak_code_search",
      input: {
        description: "Verify custom Code Search foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH_OK.",
        subagent_type: "Code Search",
      },
    },
    {
      stage: "child-custom-inherit",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT_OK",
      toolId: "toolu_e2e_offpeak_inherit",
      input: {
        description: "Verify custom inherited-model foreground agent",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT_OK.",
        subagent_type: "E2E OffPeak Inherit Reviewer",
      },
    },
  ],
  backgrounds: [
    {
      stage: "background-explicit",
      marker: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_EXPLICIT",
      toolId: "toolu_e2e_offpeak_background_explicit",
      input: {
        description: "Verify explicit background inheritance",
        prompt: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_EXPLICIT: reply when released.",
        run_in_background: true,
        subagent_type: "general-purpose",
      },
    },
    {
      stage: "background-profile",
      marker: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_PROFILE",
      toolId: "toolu_e2e_offpeak_background_profile",
      input: {
        description: "Verify profile background inheritance",
        prompt: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_PROFILE: reply when released.",
        subagent_type: "E2E OffPeak Background Reviewer",
      },
    },
  ],
} as const;

function parseMockRequestJson(requestBody: Buffer): unknown {
  try {
    return JSON.parse(requestBody.toString("utf8"));
  } catch {
    return {};
  }
}

function readRequestString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readRequestNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function readRequestBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)[key] === true;
}

function classifyForegroundSubagentScenarioRequest(requestJson: unknown): string {
  const serialized = JSON.stringify(requestJson);
  // Titles contain the same user material; classify system tasks first or the whole Agent script would be triggered by mistake.
  if (serialized.includes("Generate a concise title for this coding session."))
    return "session-title";
  if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentMarker)) {
    if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentFinal)) return "parent-wakeup";
    if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.children[0].toolId))
      return "parent-continuation";
    return "parent-initial";
  }
  for (const child of FOREGROUND_SUBAGENT_SCENARIO.children) {
    if (serialized.includes(child.marker)) return child.stage;
  }
  for (const background of FOREGROUND_SUBAGENT_SCENARIO.backgrounds) {
    if (serialized.includes(background.marker)) return background.stage;
  }
  if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentMarker)) {
    return "parent-initial";
  }
  return "unknown";
}

function buildForegroundSubagentScenarioResponse(
  stage: string,
  port: number,
): AnthropicMockResponse | undefined {
  if (stage === "session-title") {
    return anthropicMockResponse({
      content: [{ type: "text", text: '{"title":"E2E 闲时后台验证"}' }],
      stopReason: "end_turn",
    });
  }
  if (stage === "parent-initial") {
    return anthropicMockResponse({
      content: [
        {
          type: "tool_use",
          id: "toolu_e2e_offpeak_bash",
          name: "Bash",
          input: {
            run_in_background: true,
            command: `node -e 'fetch("http://127.0.0.1:${port}/__e2e/off-peak/background-bash").then(r=>r.text()).then(console.log)'`,
          },
        },
        ...FOREGROUND_SUBAGENT_SCENARIO.children.map((child) => ({
          type: "tool_use" as const,
          id: child.toolId,
          name: "Agent",
          input: child.input,
        })),
        ...FOREGROUND_SUBAGENT_SCENARIO.backgrounds.map((background) => ({
          type: "tool_use" as const,
          id: background.toolId,
          name: "Agent",
          input: background.input,
        })),
      ],
      stopReason: "tool_use",
    });
  }
  const child = FOREGROUND_SUBAGENT_SCENARIO.children.find(
    (candidate) => candidate.stage === stage,
  );
  if (child) {
    return anthropicMockResponse({
      content: [{ type: "text", text: child.reply }],
      stopReason: "end_turn",
    });
  }
  const background = FOREGROUND_SUBAGENT_SCENARIO.backgrounds.find(
    (candidate) => candidate.stage === stage,
  );
  if (background) {
    return anthropicMockResponse({
      content: [{ type: "text", text: `${background.marker}_OK` }],
      stopReason: "end_turn",
    });
  }
  if (stage === "parent-continuation" || stage === "parent-wakeup") {
    return anthropicMockResponse({
      content: [{ type: "text", text: FOREGROUND_SUBAGENT_SCENARIO.parentFinal }],
      stopReason: "end_turn",
    });
  }
  return undefined;
}

interface AnthropicMockResponse {
  content: readonly Record<string, unknown>[];
  id: string;
  model: string;
  role: "assistant";
  stop_reason: "end_turn" | "tool_use";
  type: "message";
  usage: { input_tokens: number; output_tokens: number };
}

function anthropicMockResponse(input: {
  content: readonly Record<string, unknown>[];
  stopReason: "end_turn" | "tool_use";
}): AnthropicMockResponse {
  return {
    id: `msg_offpeak_mock_${input.stopReason}`,
    type: "message",
    role: "assistant",
    model: "offpeak-mock",
    stop_reason: input.stopReason,
    content: input.content,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function respondWithAnthropicMock(
  res: ServerResponse,
  response: AnthropicMockResponse,
  stream: boolean,
): void {
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  const events: string[] = [
    anthropicSseEvent("message_start", {
      type: "message_start",
      message: { ...response, content: [], stop_reason: null },
    }),
  ];
  response.content.forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push(
        anthropicSseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        }),
        anthropicSseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input ?? {}),
          },
        }),
        anthropicSseEvent("content_block_stop", {
          type: "content_block_stop",
          index,
        }),
      );
      return;
    }
    events.push(
      anthropicSseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
      anthropicSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text ?? "" },
      }),
      anthropicSseEvent("content_block_stop", {
        type: "content_block_stop",
        index,
      }),
    );
  });
  events.push(
    anthropicSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: response.usage,
    }),
    anthropicSseEvent("message_stop", { type: "message_stop" }),
  );
  res.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
  });
  res.end(events.join(""));
}

function anthropicSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
