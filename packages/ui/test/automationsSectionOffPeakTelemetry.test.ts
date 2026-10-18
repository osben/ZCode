// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { IPlatformService, OffPeakTaskCreateResult } from "@zcode/shared";
import {
  buildOffPeakCreateResultTelemetryPayload,
  createAndReportOffPeakTask,
  freezeOffPeakCreateTelemetrySnapshot,
  reportOffPeakCreateResult,
} from "@/lib/offPeakTelemetry.js";

/** Helper behavior is already covered in offPeakTelemetry.test.ts; this smoke test uses the same
 * source types to guard against the telemetry helpers themselves regressing, which would make the
 * wiring look present while being unusable. */
describe("offPeakTelemetry helpers used by AutomationsSection (smoke)", () => {
  const successResult = {
    ok: true,
    task: {
      offPeakTaskId: "offpeak-stable-1",
      serverTicketId: "forbidden-ticket",
      title: "forbidden title",
      prompt: "forbidden prompt",
      permissionMode: "build",
      workspaceKey: "/forbidden/workspace",
      workspacePath: "/forbidden/workspace",
      status: "queued",
      queuedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    ticketInitialState: "queued",
    providerName: "api.example.com",
  } satisfies OffPeakTaskCreateResult;

  it("首页模板来源 (eventRegion=app.session) freeze 后能产出正确 payload", () => {
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.session", templateId: "standupGitSummary" },
      model: "GLM-5.2",
      providerId: "account:zai-offpeak-idle-plan",
    });
    expect(snapshot).toMatchObject({
      eventRegion: "app.session",
      templateId: "standupGitSummary",
      modelProvider: "offpeak-idle-plan",
    });
    const payload = buildOffPeakCreateResultTelemetryPayload(snapshot, successResult);
    expect(payload.elementName).toBe("off_peak_task_create_result");
    expect(payload.eventRegion).toBe("app.session");
  });

  it("Automations 模板来源 (eventRegion=app.automations) freeze 后 templateId 透传", () => {
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.automations", templateId: "ciFlakyReport" },
      model: "GLM-5.2",
    });
    expect(snapshot.templateId).toBe("ciFlakyReport");
    expect(snapshot.eventRegion).toBe("app.automations");
  });

  it("无 source 时回落到 app.automations + templateId=''（直接创建入口）", () => {
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({ model: "GLM-5.2" });
    expect(snapshot.eventRegion).toBe("app.automations");
    expect(snapshot.templateId).toBe("");
  });

  it("灰度门禁失败 payload 含 failure_stage=client_validation", () => {
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.automations", templateId: "ciFlakyReport" },
      model: "GLM-5.2",
    });
    const payload = buildOffPeakCreateResultTelemetryPayload(snapshot, {
      ok: false,
      failureStage: "client_validation",
      errorCategory: "client_validation",
      errorCode: "",
      providerName: "",
    });
    expect(payload.eventExtraDetail).toMatchObject({
      result: "failure",
      failure_stage: "client_validation",
      error_category: "client_validation",
    });
  });

  it("createAndReportOffPeakTask 触发恰好一次 reportTelemetryEvent（best-effort 边界）", async () => {
    const reportTelemetryEvent = vi.fn(async () => undefined);
    const platform = {
      reportTelemetryEvent,
    } as unknown as Pick<IPlatformService, "reportTelemetryEvent">;
    const create = vi.fn(async () => successResult);
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.session", templateId: "standupGitSummary" },
      model: "GLM-5.2",
    });
    await createAndReportOffPeakTask(platform, snapshot, create);
    // fire-and-forget: needs a microtask flush
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reportTelemetryEvent).toHaveBeenCalledOnce();
  });

  it("reportOffPeakCreateResult reporter 拒绝被吞掉不抛", async () => {
    const reportTelemetryEvent = vi.fn().mockRejectedValue(new Error("network"));
    const platform = {
      reportTelemetryEvent,
    } as unknown as Pick<IPlatformService, "reportTelemetryEvent">;
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({ model: "GLM-5.2" });
    await expect(
      reportOffPeakCreateResult(platform, snapshot, successResult),
    ).resolves.toBeUndefined();
  });
});
