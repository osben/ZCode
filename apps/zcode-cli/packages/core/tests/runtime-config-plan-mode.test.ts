import { describe, expect, it } from "vitest";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";
import { DEFAULT_HARNESS_PROMPT } from "@zcode/shared";
import { createRuntimeSessionModePort } from "../src/runtime/session-mode-port.js";
import { updateConfig } from "../src/runtime/methods/config.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

function systemMessagesText(messages: readonly { content?: unknown }[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .map((part) =>
            typeof part === "string" ? part : String((part as { text?: string }).text ?? ""),
          )
          .join("");
      }
      return "";
    })
    .join("\n");
}

// 旧 mode=plan 只在兼容入口拆分；新输入的权限与 Plan 可以分别变化。
describe("updateConfig independent Plan", () => {
  it.each(["build", "edit", "guarded", "yolo"] as const)("进入/退出 Plan 保留 %s 权限", (mode) => {
    const fixture = { config: { mode, planEnabled: false }, needsPlanModeExitReminder: false };
    const runtime = fixture as unknown as AgentRuntimeInternal;
    updateConfig.call(runtime, { mode: "plan" });
    expect(fixture.config).toEqual({ mode, planEnabled: true });
    updateConfig.call(runtime, { mode: "plan" });
    expect(fixture.config).toEqual({ mode, planEnabled: true });
    updateConfig.call(runtime, { planEnabled: false });
    expect(fixture.config).toEqual({ mode, planEnabled: false });
    expect(fixture.needsPlanModeExitReminder).toBe(true);
  });
  it("Guarded 的 Enter/Exit 工具只切换 Plan 标记", async () => {
    const runtime = {
      config: { mode: "guarded", planEnabled: false },
      createEvent: (type: unknown, payload: unknown) => ({ type, payload }),
      appendEvent: async () => undefined,
    } as unknown as AgentRuntimeInternal;
    const port = createRuntimeSessionModePort(runtime);
    expect(await port.enterPlanMode()).toMatchObject({ mode: "guarded", planEnabled: true });
    expect(await port.exitPlanMode()).toMatchObject({ mode: "guarded", planEnabled: false });
  });
  it("新提交明确携带 true，改变权限不退出规划", () => {
    const runtime = { config: { mode: "build", planEnabled: true } } as AgentRuntimeInternal;
    updateConfig.call(runtime, { mode: "yolo", planEnabled: true });
    expect(runtime.config).toMatchObject({ mode: "yolo", planEnabled: true });
    updateConfig.call(runtime, { mode: "edit" });
    expect(runtime.config).toMatchObject({ mode: "edit", planEnabled: false });
  });
  it("systemPromptOverrides 补丁写入运行时配置", () => {
    // 空闲会话（无 activeTurn）触发一次上下文前缀重建；contextBuilder 未初始化时该路径
    // 只借用消息历史，这里用最小 stub 验证补丁写入配置。
    const runtime = {
      config: {},
      messageHistory: { borrowReadOnlyRuntimeEntries: () => [] },
    } as unknown as AgentRuntimeInternal;
    updateConfig.call(runtime, { systemPromptOverrides: { harness: "Mine." } });
    expect(runtime.config.systemPromptOverrides).toEqual({ harness: "Mine." });
  });
  it("systemPromptOverrides 补丁实时重应用空闲会话的上下文前缀", async () => {
    // 行为级回归：初始化过上下文的空闲会话，补丁后重建的前缀必须携带新 override；
    // 若 updateConfig 的 rebuild 分支被移除，旧 builder 仍会渲染默认 Harness 而在此失败。
    const sessionId = createSessionId("sysprompt-live-reapply");
    const traceContext = createRootTraceContext({ sessionId });
    const runtime = createTestAgentRuntime(sessionId, { workingDirectory: "/fixture" }, {
      eventStore: createTestSessionEventStore(),
    });

    await runtime.ensureContextInitialized(traceContext);
    const beforeText = systemMessagesText(runtime.getContextBuilder().build().systemMessages);
    expect(beforeText).toContain(DEFAULT_HARNESS_PROMPT);

    runtime.updateConfig({ systemPromptOverrides: { harness: "# Harness\n- Live reapply." } });

    const afterText = systemMessagesText(runtime.getContextBuilder().build().systemMessages);
    expect(afterText).toContain("# Harness\n- Live reapply.");
    expect(afterText).not.toContain(DEFAULT_HARNESS_PROMPT);
  });
});
