import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionId, createTurnId, createTraceId, createToolCallId } from "@zcode/contracts";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { resolveSubagentSelection } from "../src/runtime/helpers/subagent-selection.js";
import { createErrorResult } from "../src/tool/executor/errors.js";
import { modelContentForToolResult } from "../src/runtime/helpers/tool-result.js";
import { createTurnFailureError } from "../src/runtime/helpers/turn-errors.js";

describe("Subagent 选择错误经过真实前后台 runner", () => {
  it.each([false, true])("background=%s 的启动失败向父模型保留原因", async (background) => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-selection-error-"));
    const events: unknown[] = [];
    const sessionId = createSessionId("selection-error-parent");
    const turnId = createTurnId("selection-error-turn");
    const port = createExploreSubagentPort({
      outputRootDir,
      createAgentId: () => "selection-error-agent",
      emitParentEvent: async (event) => {
        events.push(event);
      },
      runExploreAgent: async () => {
        resolveSubagentSelection({
          profileSelection: {
            providerId: "account:bigmodel-individual-coding-plan",
            modelId: "GLM-5.3",
          },
          resolveSelection: () => ({
            effectiveSelection: null,
            selectionIssue: "reasoning-level-missing",
          }),
        });
        throw new Error("must not start model");
      },
    });
    const request = {
      agentType: "general-purpose",
      description: "selection failure",
      prompt: "unused",
      parentToolCallId: createToolCallId("selection-error-call"),
      sessionId,
      turnId,
      trace: { traceId: createTraceId(), sessionId, turnId },
      workingDirectory: outputRootDir,
      workspaceRoot: outputRootDir,
    };
    try {
      let caught: Error | undefined;
      try {
        await (background ? port.start!(request) : port.run(request));
      } catch (error) {
        caught = error as Error;
      }
      expect(caught?.message).toContain("reasoning-level-missing");
      const result = createErrorResult(
        { id: "selection-error-call", name: "Agent", input: {} } as Parameters<
          typeof createErrorResult
        >[0],
        caught!,
      );
      expect(modelContentForToolResult(result)).toContain("未选择思考档位");
      expect(result.error?.detail).toContain("reason=reasoning-level-missing");
      // 创建前失败不能伪造已启动子任务事件；错误沿本次 Agent 工具失败返回父模型。
      expect(JSON.stringify(events)).not.toContain('"subagent_spawned"');
    } finally {
      await rm(outputRootDir, { recursive: true, force: true });
    }
  });

  it("foreground child terminal provider failure reaches the parent with its facts", async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-provider-failure-"));
    const sessionId = createSessionId("provider-failure-parent");
    const turnId = createTurnId("provider-failure-turn");
    const port = createExploreSubagentPort({
      outputRootDir,
      createAgentId: () => "provider-failure-agent",
      emitParentEvent: async () => {},
      runExploreAgent: async () => {
        // Shape thrown by the child turn: turn wrapper around the adapter's normalized error.
        throw createTurnFailureError(
          Object.assign(new Error("request has been blocked due to unusual activity."), {
            code: "provider_error",
            context: {
              modelId: "glm-5.3",
              providerCode: "3012",
              providerId: "zai-coding-plan",
              requestId: "req_secret",
              retryable: false,
              source: "provider",
              statusCode: 405,
            },
            name: "AiSdkModelAdapterError",
          }),
          undefined,
          "Turn execution failed",
        );
      },
    });
    try {
      let caught: Error | undefined;
      try {
        await port.run({
          agentType: "general-purpose",
          description: "provider failure",
          prompt: "unused",
          parentToolCallId: createToolCallId("provider-failure-call"),
          sessionId,
          turnId,
          trace: { traceId: createTraceId(), sessionId, turnId },
          workingDirectory: outputRootDir,
          workspaceRoot: outputRootDir,
        });
      } catch (error) {
        caught = error as Error;
      }
      const result = createErrorResult(
        { id: "provider-failure-call", name: "Agent", input: {} } as Parameters<
          typeof createErrorResult
        >[0],
        caught!,
      );

      expect(result.error?.attribution).toEqual({
        source: "provider",
        providerErrorCode: "3012",
        retryable: false,
        statusCode: 405,
      });
      const text = modelContentForToolResult(result);
      expect(text).toBe(
        "request has been blocked due to unusual activity.\n\nProvider failure: status=405 provider_error_code=3012 retryable=false",
      );
    } finally {
      await rm(outputRootDir, { recursive: true, force: true });
    }
  });
});
