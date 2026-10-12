import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OffPeakTaskRepo } from "../src/session/offPeakTaskRepo.js";
import { OffPeakTaskService } from "../src/session/offPeakTaskService.js";
import { createOffPeakServerClient } from "../src/session/offPeakServerClient.js";
import {
  startOffPeakMockGateway,
  type OffPeakMockGatewayHandle,
} from "../src/session/offPeakMockGateway.js";
import { setDataBaseDir } from "../src/paths.js";
import { createServiceLogger } from "../src/logger/serviceLogger.js";

// End-to-end integration (mock gateway + server client + orchestration service + repo, full chain for real):
// covers the OP01/OP02/OP07 service-layer mechanics — take-ticket queuing → polling promotion to ready →
// dispatch to running → 3h expiry 400/3102 resume re-ticketing → completion → settle. WDIO GUI E2E
// (OP01-OP06) is separate.

const logger = createServiceLogger("off-peak-e2e", { isDebugEnabled: false });

describe("off-peak 端到端集成（进程内 mock 网关全链路）", () => {
  let tempDir: string | null = null;
  let repo: OffPeakTaskRepo;
  let gateway: OffPeakMockGatewayHandle;
  let service: OffPeakTaskService;
  let wakes: number;

  async function boot(gatewayOptions: Parameters<typeof startOffPeakMockGateway>[1]) {
    gateway = await startOffPeakMockGateway(
      // resolveUpstream returns null → the gateway answers with a fixed response; no real model key needed.
      { logger, resolveUpstream: async () => null },
      { port: 0, nextPollS: 0, ...gatewayOptions },
    );
    const client = createOffPeakServerClient({
      resolveOrigin: () => gateway.origin,
      resolveCredentials: async () => ({
        jwt: "jwt",
        codingPlanApiKey: "cp",
        kind: "bigmodel-personal",
        providerFamily: "bigmodel",
        providerId: "account:bigmodel-individual-coding-plan",
        selectedConnectionKey: "coding-plan:account:bigmodel-individual-coding-plan",
      }),
      logger,
    });
    service = new OffPeakTaskService({
      repo,
      client,
      logger,
      resolveCodingPlanSupport: async () => ({
        supported: true,
        kind: "bigmodel-personal",
        providerFamily: "bigmodel",
        providerId: "account:bigmodel-individual-coding-plan",
        selectedConnectionKey: "coding-plan:account:bigmodel-individual-coding-plan",
      }),
      resolveTelemetryProviderName: async () => "127.0.0.1",
      resolveModelSelection: async ({ modelId, reasoningLevel }) => ({
        ok: true as const,
        selection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: modelId ?? "GLM-5.2",
          ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
        },
      }),
      requestSchedulerWake: () => {
        wakes += 1;
      },
    });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-off-peak-e2e-"));
    setDataBaseDir(tempDir);
    repo = new OffPeakTaskRepo();
    wakes = 0;
  });

  afterEach(async () => {
    service?.stopSync();
    await gateway?.close();
    repo.close();
    setDataBaseDir(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  const createParams = {
    title: "集成夜跑",
    prompt: "整理 TODO",
    permissionMode: "build",
    workspacePath: "/tmp/ws",
    modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
  };

  const createTask = async () => {
    const result = await service.createTask(createParams);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected integrated task creation");
    return result.task;
  };

  it("OP02 机制：取号→轮询晋级 ready→scheduler 认领→网关准入(固定响应)→settle", async () => {
    // readyDelayMs=0: ready at ticket time (idle off-peak promotes immediately); createTask wakes the scheduler for immediate dispatch.
    await boot({ readyDelayMs: 0, activeMs: 60_000 });
    const created = await createTask();
    expect(created.status).toBe("queued");
    expect(created.schedulable).toBe(true); // ready at ticket time
    expect(wakes).toBe(1);

    // scheduler claim (queued with schedulable=1)
    const claimed = await repo.claimDue(Date.now());
    expect(claimed.map((t) => t.offPeakTaskId)).toEqual([created.offPeakTaskId]);

    // Dispatch admission: hit the gateway messages endpoint directly (simulating the idle plan provider's first request)
    const sendMessage = async (ticketId: string) =>
      fetch(`${gateway.origin}/api/v1/off-peak/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-off-peak-ticket-id": ticketId },
        body: JSON.stringify({ model: "GLM-5.2", messages: [{ role: "user", content: "go" }] }),
      });
    const admitted = await sendMessage(created.serverTicketId!);
    expect(admitted.status).toBe(200);
    const body = (await admitted.json()) as { stop_reason: string };
    expect(body.stop_reason).toBe("end_turn"); // fixed response; the loop finishes immediately

    // Host side: markRunning → markTerminal(completed)
    await repo.markRunning(created.offPeakTaskId, {
      startedAt: Date.now(),
      conversationId: "conv-1",
      sessionId: "sess-1",
    });
    await repo.markTerminal(created.offPeakTaskId, { status: "completed", endedAt: Date.now() });

    // Settle the outbox (piggybacked by the service cycle)
    await service.runSyncCycle();
    const settled = await repo.get(created.offPeakTaskId);
    expect(settled?.status).toBe("completed");
    expect(settled?.settledAt).toBeDefined();
  });

  it("OP07 机制：active 到期 400/3102 → 同 task_id 续跑重取号 → 新票再准入", async () => {
    // activeMs is very short: it expires right after the first message is admitted, and the next message receives 3102.
    await boot({ readyDelayMs: 0, activeMs: 20 });
    const created = await createTask();
    const firstTicket = created.serverTicketId!;

    const sendMessage = async (ticketId: string) =>
      fetch(`${gateway.origin}/api/v1/off-peak/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-off-peak-ticket-id": ticketId },
        body: JSON.stringify({ messages: [] }),
      });
    expect((await sendMessage(firstTicket)).status).toBe(200); // admitted while active

    await repo.markRunning(created.offPeakTaskId, {
      startedAt: Date.now(),
      conversationId: "conv-1",
      sessionId: "sess-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 40)); // past activeMs
    const expired = await sendMessage(firstTicket);
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { code: number }).code).toBe(3102);

    // Host recognizes 3102 → handleTicketExpiredDuringRun requeues and re-takes a ticket
    await service.handleTicketExpiredDuringRun(created.offPeakTaskId);
    const requeued = await repo.get(created.offPeakTaskId);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.sessionId).toBe("sess-1"); // session kept for resume
    expect(requeued?.serverTicketId).not.toBe(firstTicket); // new ticket

    // The new ticket is admitted again
    const resumed = await sendMessage(requeued!.serverTicketId!);
    expect(resumed.status).toBe(200);
  });

  it("OP04 机制：queued Pause 停派发→ready 过期停在 paused→Continue 重取号回队", async () => {
    // readyDelayMs slightly longer so the task stays queued after ticketing and can be paused; readyTtl short so the
    // ticket naturally expires while paused.
    await boot({ readyDelayMs: 30, readyTtlMs: 20, activeMs: 60_000 });
    const created = await createTask();
    expect(created.schedulable).toBe(false); // not promoted at ticket time

    const paused = await service.pauseTask(created.offPeakTaskId);
    expect(paused?.status).toBe("paused");

    // While paused, polling promotes the ticket to ready (readyTtl counts from promotion); paused tasks do not auto re-ticket (D29-3)
    await new Promise((resolve) => setTimeout(resolve, 40));
    await service.runSyncCycle();
    // Wait past readyTtl so the ready ticket expires naturally
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stillPaused = await repo.get(created.offPeakTaskId);
    expect(stillPaused?.status).toBe("paused");

    // Continue: the ticket is void → manual re-ticketing to the queue tail
    const firstTicket = created.serverTicketId;
    await service.continueTask(created.offPeakTaskId);
    const continued = await repo.get(created.offPeakTaskId);
    expect(continued?.status).toBe("queued");
    expect(continued?.serverTicketId).not.toBe(firstTicket);
  });
});
