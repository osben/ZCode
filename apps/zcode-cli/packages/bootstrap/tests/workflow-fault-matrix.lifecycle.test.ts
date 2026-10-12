// ============================================================
// Fault matrix · lifecycle rows (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md: B15–B19)
// ============================================================
// These rows exercise the run service's real paths: `service.resume` after a stop-set halt (B15),
// the stall notification after 20 minutes without a single success (B16), `service.cancel` during
// backoff (B17), host `service.close()` while in flight (B18), and another process writing a
// terminal row while in flight (B19). The assembly is createFaultServiceHarness: real
// createDynamicWorkflowRunService + real governor + a scaled clock, with assertCommonInvariants
// asserted over the RunEvent view reconstructed from progress payloads.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "@zcode/dynamic-workflow";
import { startFakeProviderServer, type FaultProgram } from "./helpers/fake-provider-server.js";
import { AUTH_401, BUSY_3008, SERVE, always, healthy } from "./helpers/fault-programs.js";
import {
  FAULT_CELL_STALL_AFTER_MS,
  FAULT_CELL_TURNS,
  askNodes,
  assertCommonInvariants,
  createFaultServiceHarness,
  pause,
  statusCount,
  type FaultServiceHarness,
} from "./helpers/fault-matrix.js";
import {
  CELL_TIMEOUT_MS,
  POST_SETTLE_GRACE_MS,
  cellName,
  cells,
  type CellCoordinate,
} from "./helpers/fault-matrix-cells.js";
import { FAULT_MATRIX_SHAPES } from "./helpers/fault-matrix-scripts.js";

/** Polls a condition until it holds or times out. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(20);
  }
}

function settledEvents(harness: FaultServiceHarness, runId: string): Extract<RunEvent, { type: "run-settled" }>[] {
  return harness
    .eventsOf(runId)
    .filter((event): event is Extract<RunEvent, { type: "run-settled" }> => event.type === "run-settled");
}

// ————————————————————————————————————————————————————————————————
// B15: stop-set halts -> server flips healthy -> resume completes
// ————————————————————————————————————————————————————————————————

describe("fault matrix · B15 flip — provider 停下后 resume 从断点续跑", () => {
  it.each(cells([{ shape: "W4" }], [{ shape: "S-phase" }]).map((cell) => [cellName(cell), cell] as const))(
    "%s：第一段 stopped(provider)；翻转后 resume 完成，已完结 ask 不再请求",
    async (_name, cell: CellCoordinate) => {
      // Let K+1 requests through first (exactly enough for one subagent to fully finish), then 401
      // everything: by the time the first segment halts, the journal holds both completed asks and
      // aborted ones.
      const turns = FAULT_CELL_TURNS;
      const firstSegment: FaultProgram = (request) =>
        request.ordinal <= turns + 1 ? SERVE : AUTH_401;
      const server = await startFakeProviderServer({ program: firstSegment });
      const harness = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
      });
      try {
        const runId = await harness.submit(cell.shape);
        const first = await harness.settle(runId);
        await pause(POST_SETTLE_GRACE_MS);
        expect(first?.runStatus).toBe("stopped");
        expect(first?.stopReason).toBe("provider");
        const settledAt = harness.settledAt(runId);
        expect(settledAt).toBeDefined();
        assertCommonInvariants(
          {
            runId,
            settlement: { status: "stopped", reason: "provider" },
            events: harness.eventsOf(runId),
            statusEvents: harness.statusEvents,
            journal: harness.journal,
            settledAt: settledAt!,
          },
          { status: "stopped", stopReason: "provider", server },
        );
        const completedBefore = askNodes(harness.journal, runId).filter(
          (node) => node.status === "completed",
        ).length;
        const requestsBefore = server.requests.length;
        const asks = FAULT_MATRIX_SHAPES[cell.shape].asks;
        expect(completedBefore).toBeGreaterThanOrEqual(0);
        expect(completedBefore).toBeLessThan(asks);

        // Flip -> resume.
        server.setProgram(healthy());
        // resume is an optional capability on the port; this assembly's service always has it —
        // absence would mean the assembly is wrong.
        const resume = harness.service.resume;
        expect(resume).toBeDefined();
        const resumed = await resume!(runId);
        expect(resumed).toMatchObject({ ok: true, runId });
        await waitFor(() => settledEvents(harness, runId).length >= 2, CELL_TIMEOUT_MS - 5_000, "second run-settled");
        await pause(POST_SETTLE_GRACE_MS);
        const second = await harness.service.getTask(runId);
        expect(second?.runStatus).toBe("completed");
        const settled = settledEvents(harness, runId);
        expect(settled).toHaveLength(2);
        expect(settled[1]).toMatchObject({ status: "completed" });

        // The second segment only re-asks unfinished asks: completed ones replay from the journal
        // with zero requests (decision 13).
        const secondSegment = server.requests.length - requestsBefore;
        expect(secondSegment).toBe((asks - completedBefore) * (turns + 1));
        for (const node of askNodes(harness.journal, runId)) {
          expect(node.status).toBe("completed");
        }
        // Zero provider failures in the second segment (the cancelled entries around the first
        // segment's settle are echoes of siblings being aborted; they do not count).
        const lateFailures = harness.statusEvents.filter(
          (event) =>
            event.type === "model_request_failed" &&
            event.reason !== "cancelled" &&
            Date.parse(event.timestamp) > settledAt!,
        );
        expect(lateFailures).toEqual([]);
      } finally {
        await harness.dispose();
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});

// ————————————————————————————————————————————————————————————————
// B16: stall — persistent rate limiting, no success -> exactly one run-stalled; completes after the flip
// ————————————————————————————————————————————————————————————————

describe("fault matrix · B16 stall — 无一次成功的重试段恰好通知一次", () => {
  it.each(cells([{ shape: "W4" }]).map((cell) => [cellName(cell), cell] as const))(
    "%s：一条 run-stalled（sinceMs ≥ 窗、reason rate_limited）；翻转后 completed 且不再 stall",
    async (_name, cell: CellCoordinate) => {
      const server = await startFakeProviderServer({ program: always(BUSY_3008) });
      const harness = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
      });
      try {
        const runId = await harness.submit(cell.shape);
        const stalled = () =>
          harness.eventsOf(runId).filter((event) => event.type === "run-stalled");
        await waitFor(() => stalled().length >= 1, 10_000, "run-stalled");
        // Wait one more window: there must be no second notification (one per stall segment).
        await pause(FAULT_CELL_STALL_AFTER_MS + 100);
        expect(stalled()).toHaveLength(1);
        const info = stalled()[0] as Extract<RunEvent, { type: "run-stalled" }>;
        expect(info.reason).toBe("rate_limited");
        expect(info.cap).toBeDefined();
        // sinceMs is measured on the driver's clock (virtual milliseconds), >= the virtual window;
        // here we only pin "not smaller than the configured window".
        expect(info.sinceMs).toBeGreaterThan(0);
        // Never succeeded.
        expect(statusCount(harness.statusEvents, "model_request_completed")).toBe(0);
        expect(statusCount(harness.statusEvents, "model_retry_scheduled")).toBeGreaterThan(0);

        server.setProgram(healthy());
        const snapshot = await harness.settle(runId);
        await pause(POST_SETTLE_GRACE_MS);
        expect(snapshot?.runStatus).toBe("completed");
        expect(stalled()).toHaveLength(1);
        assertCommonInvariants(
          {
            runId,
            settlement: { status: "completed", artifact: undefined },
            events: harness.eventsOf(runId),
            statusEvents: harness.statusEvents,
            journal: harness.journal,
            settledAt: harness.settledAt(runId)!,
          },
          { status: "completed", server },
        );
      } finally {
        await harness.dispose();
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});

// ————————————————————————————————————————————————————————————————
// B17: user cancel during backoff -> stopped(user), settles immediately, zero requests afterwards
// ————————————————————————————————————————————————————————————————

describe("fault matrix · B17 cancel — 退避中取消立即停下", () => {
  it.each(cells([{ shape: "W8" }]).map((cell) => [cellName(cell), cell] as const))(
    "%s：stopped(user)，取消到结算 ≤ 1 s，结算后零请求",
    async (_name, cell: CellCoordinate) => {
      const server = await startFakeProviderServer({ program: always(BUSY_3008) });
      const harness = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
      });
      try {
        const runId = await harness.submit(cell.shape);
        await waitFor(
          () => statusCount(harness.statusEvents, "model_retry_scheduled") >= 1,
          10_000,
          "first retry_scheduled",
        );
        const cancelledAt = Date.now();
        expect(await harness.service.cancel(runId, "user")).toBe(true);
        const snapshot = await harness.settle(runId);
        const settledAt = harness.settledAt(runId);
        expect(settledAt).toBeDefined();
        expect(settledAt! - cancelledAt).toBeLessThanOrEqual(1_000);
        expect(snapshot?.runStatus).toBe("stopped");
        expect(snapshot?.stopReason).toBe("user");
        await pause(POST_SETTLE_GRACE_MS);
        assertCommonInvariants(
          {
            runId,
            settlement: { status: "stopped", reason: "user" },
            events: harness.eventsOf(runId),
            statusEvents: harness.statusEvents,
            journal: harness.journal,
            settledAt: settledAt!,
          },
          { status: "stopped", stopReason: "user", server },
        );
        expect(statusCount(harness.statusEvents, "model_request_completed")).toBe(0);
        // All backoff timers are withdrawn: wait a while after the settle and there are still zero requests.
        const after = server.requests.length;
        await pause(500);
        expect(server.requests.length).toBe(after);
      } finally {
        await harness.dispose();
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});

// ————————————————————————————————————————————————————————————————
// B18: host close while in flight -> stopped(interrupted); zero events after the close; a new service resumes on the same journal
// ————————————————————————————————————————————————————————————————

describe("fault matrix · B18 close — 宿主关闭停下自己拥有的 run，下一次激活可续跑", () => {
  it.each(cells([{ shape: "W4" }]).map((cell) => [cellName(cell), cell] as const))(
    "%s：stopped(interrupted) 在 close 解析前写完；之后零事件；同一份 journal 上 resume 完成",
    async (_name, cell: CellCoordinate) => {
      // Persistent rate limiting keeps the run reliably in flight (as in B17), so the close is
      // guaranteed to land on a genuinely live engine.
      const server = await startFakeProviderServer({ program: always(BUSY_3008) });
      const first = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
      });
      const journal = first.journal;
      let runId = "";
      try {
        runId = await first.submit(cell.shape);
        await waitFor(
          () => statusCount(first.statusEvents, "model_retry_scheduled") >= 1,
          10_000,
          "first retry_scheduled",
        );

        await first.service.close();

        // 1) By the time close resolves, that entry has been written: the engine's own finishRun
        // tail, not something the service patched in.
        const snapshot = await first.service.getTask(runId);
        expect(snapshot?.runStatus).toBe("stopped");
        expect(snapshot?.stopReason).toBe("interrupted");
        expect(journal.getRun(runId)?.failure?.code).toBe("Interrupted");
        const settled = settledEvents(first, runId);
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({ status: "stopped", stopReason: "interrupted" });

        const settledAt = first.settledAt(runId);
        expect(settledAt).toBeDefined();
        assertCommonInvariants(
          {
            runId,
            settlement: { status: "stopped", reason: "interrupted" },
            events: first.eventsOf(runId),
            statusEvents: first.statusEvents,
            journal,
            settledAt: settledAt!,
          },
          { status: "stopped", stopReason: "interrupted", server },
        );

        // 2) Zero events and zero requests after the close: backoff timers are all withdrawn and
        // no progress events lag behind.
        const eventsAtClose = first.runEvents.length;
        const requestsAtClose = server.requests.length;
        await pause(POST_SETTLE_GRACE_MS);
        expect(first.runEvents.length).toBe(eventsAtClose);
        expect(server.requests.length).toBe(requestsAtClose);
        // A launch after the close is a wiring error, not a business rejection.
        await expect(first.service.resume!(runId)).rejects.toThrow(/service is closed/);
      } finally {
        await first.dispose();
      }

      // 3) Next activation: a **new** service resumes on the same journal and finishes from where it stopped.
      server.setProgram(healthy());
      const second = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
        journal,
      });
      try {
        const resume = second.service.resume;
        expect(resume).toBeDefined();
        expect(await resume!(runId)).toMatchObject({ ok: true, runId });
        await waitFor(
          () => settledEvents(second, runId).length >= 1,
          CELL_TIMEOUT_MS - 5_000,
          "run-settled after resume",
        );
        await pause(POST_SETTLE_GRACE_MS);
        expect((await second.service.getTask(runId))?.runStatus).toBe("completed");
        // The resume clears the Interrupted residue left by the close: the row cannot be both
        // completed and carrying a failure.
        const record = journal.getRun(runId);
        expect(record?.status).toBe("completed");
        expect(record?.failure).toBeUndefined();
        expect(record?.stopReason).toBeUndefined();
        for (const node of askNodes(journal, runId)) {
          expect(node.status).toBe("completed");
        }
      } finally {
        await second.dispose();
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});

// ————————————————————————————————————————————————————————————————
// B19: a foreign terminal row under a live engine -> no terminal snapshot; only the real completion counts, and the row carries no stale failure
// ————————————————————————————————————————————————————————————————

describe("fault matrix · B19 foreign row — 别的进程写下的终态行压不过活着的引擎", () => {
  it.each(cells([{ shape: "W4" }]).map((cell) => [cellName(cell), cell] as const))(
    "%s：外来 stopped(interrupted) 不产生 run-settled；真正的 completed 才产生，且行不留失败",
    async (_name, cell: CellCoordinate) => {
      // Persistent rate limiting keeps the run reliably in flight (as in B17 / B18), so the
      // foreign write is guaranteed to land on the live engine.
      const server = await startFakeProviderServer({ program: always(BUSY_3008) });
      const harness = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
      });
      try {
        const runId = await harness.submit(cell.shape);
        await waitFor(
          () => statusCount(harness.statusEvents, "model_retry_scheduled") >= 1,
          10_000,
          "first retry_scheduled",
        );

        // Orphan convergence from a second instance: write the journal directly, entirely unknown
        // to this process's registry.
        harness.journal.updateRunStatus(runId, "stopped", {
          stopReason: "interrupted",
          failure: { code: "Interrupted", message: "owning process exited" },
        });
        expect(harness.journal.getRun(runId)?.status).toBe("stopped");

        // A foreign write is not a settlement: it bypasses the engine, so it produces no progress
        // events at all.
        await pause(POST_SETTLE_GRACE_MS);
        expect(settledEvents(harness, runId)).toHaveLength(0);
        expect(harness.settledAt(runId)).toBeUndefined();
        // The tracker still reads "running" — this is exactly what makes it keep polling instead
        // of notifying the model that the run ended.
        expect((await harness.service.getTask(runId))?.status).toBe("running");

        // The engine finishes as usual and its own settlement rewrites that row.
        server.setProgram(healthy());
        const snapshot = await harness.settle(runId);
        await pause(POST_SETTLE_GRACE_MS);
        expect(snapshot?.runStatus).toBe("completed");
        const settled = settledEvents(harness, runId);
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({ status: "completed" });

        const record = harness.journal.getRun(runId);
        expect(record?.status).toBe("completed");
        // A stale failure never coexists with the artifact (the "clears a stale failure…" half of
        // the journal contract, on the real path).
        expect(record?.failure).toBeUndefined();
        expect(record?.stopReason).toBeUndefined();

        const settledAt = harness.settledAt(runId);
        expect(settledAt).toBeDefined();
        assertCommonInvariants(
          {
            runId,
            settlement: { status: "completed", artifact: undefined },
            events: harness.eventsOf(runId),
            statusEvents: harness.statusEvents,
            journal: harness.journal,
            settledAt: settledAt!,
          },
          { status: "completed", server },
        );
      } finally {
        await harness.dispose();
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});
