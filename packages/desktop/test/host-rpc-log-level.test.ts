import { describe, expect, it } from "vitest";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "@zcode/services";
import { resolveRpcLogLevel } from "../src/host/rpcLogLevel.js";

describe("host RPC 日志级别映射", () => {
  it("后台 Bash 成功轮询仅记 debug，失败仍记 warn", () => {
    expect(resolveRpcLogLevel("[rpc:call] zcode-agent.backgroundBashOutputV4 OK (1.5ms)")).toBe(
      "debug",
    );
    expect(resolveRpcLogLevel("[rpc:call] zcode-agent.backgroundBashOutputV4 FAIL (1.5ms)")).toBe(
      "warn",
    );
    expect(
      resolveRpcLogLevel("[rpc:call] zcode-agent.otherBackgroundBashOutputV4 OK (1.5ms)"),
    ).toBe("info");
  });

  it("dictation runtime-state polling successes are debug, failures stay warn", () => {
    expect(resolveRpcLogLevel("[rpc:call] voice-dictation.getRuntimeState OK (0.4ms)")).toBe(
      "debug",
    );
    expect(resolveRpcLogLevel("[rpc:call] voice-dictation.getRuntimeState FAIL (0.4ms)")).toBe(
      "warn",
    );
    // Other dictation calls keep their normal level.
    expect(resolveRpcLogLevel("[rpc:call] voice-dictation.warmUp OK (900ms)")).toBe("info");
  });

  it("RPC 成功日志应记为 info", () => {
    expect(resolveRpcLogLevel("[rpc:call] setting.get OK (1.5ms)")).toBe("info");
  });

  it("RPC 失败日志应记为 warn", () => {
    expect(resolveRpcLogLevel("[rpc:call] setting.get FAIL (1.5ms)")).toBe("warn");
  });

  it("provider registry 尚未就绪的 runtime identity 查询应记为 info", () => {
    const error = Object.assign(new Error("provider not ready"), {
      code: "ZCODE_AGENT_PROVIDER_NOT_READY",
    });

    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-session.getWorkspaceRuntimeIdentity FAIL (12.0ms)",
        error,
      ),
    ).toBe("info");
  });
});

describe("host RPC log level: expected runtime-unavailable sessions-index probe", () => {
  const runtimeUnavailable = () =>
    Object.assign(new Error("ZCode Agent runtime is not running."), {
      code: ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
    });

  it("logs a runtime-unavailable subscribeSessionsIndexV4 failure at info", () => {
    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-agent.subscribeSessionsIndexV4 FAIL (0.1ms)",
        runtimeUnavailable(),
      ),
    ).toBe("info");
  });

  it("keeps the same failure at warn when it carries no runtime-unavailable code", () => {
    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-agent.subscribeSessionsIndexV4 FAIL (0.1ms)",
        new Error("ZCode Agent runtime is not running."),
      ),
    ).toBe("warn");
    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-agent.subscribeSessionsIndexV4 FAIL (0.1ms)",
        Object.assign(new Error("boom"), { code: "SOMETHING_ELSE" }),
      ),
    ).toBe("warn");
  });

  it("keeps other methods carrying the runtime-unavailable code at warn", () => {
    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-agent.subscribeWorkspaceConfigV4 FAIL (0.1ms)",
        runtimeUnavailable(),
      ),
    ).toBe("warn");
    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-agent.otherSubscribeSessionsIndexV4 FAIL (0.1ms)",
        runtimeUnavailable(),
      ),
    ).toBe("warn");
  });
});

describe("host RPC log level: expected not-found for a just-created session's workflow run list", () => {
  const sessionNotFound = (sessionId: string) =>
    new Error(`fault.workflowRuns.sessionNotFound: ${sessionId}`);

  it("logs the cold-session workflowRuns sessionNotFound failure at info", () => {
    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-agent.conversationWorkflowRunsV4 FAIL (2.0ms)",
        sessionNotFound("sess-1"),
      ),
    ).toBe("info");
  });

  it("keeps other workflowRuns failures at warn", () => {
    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-agent.conversationWorkflowRunsV4 FAIL (2.0ms)",
        new Error("fault.command.capabilityUnsupported: sess-1"),
      ),
    ).toBe("warn");
    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-agent.conversationWorkflowRunsV4 FAIL (2.0ms)",
        new Error("socket hang up"),
      ),
    ).toBe("warn");
  });

  it("keeps the same sessionNotFound message on other workflow RPCs at warn", () => {
    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-agent.conversationWorkflowRunArtifactsV4 FAIL (2.0ms)",
        sessionNotFound("sess-1"),
      ),
    ).toBe("warn");
    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-agent.conversationWorkflowRunEventsV4 FAIL (2.0ms)",
        new Error("fault.workflowRunEvents.sessionNotFound: sess-1"),
      ),
    ).toBe("warn");
  });
});

describe("host RPC log level: saved-workflows directory watch before the directory exists", () => {
  const watchEnoent = (path: string) =>
    new Error(`无法监视目录 '${path}': ENOENT: no such file or directory, watch '${path}'`);

  it("logs a missing <project>/.zcode/workflows watch at info", () => {
    expect(
      resolveRpcLogLevel(
        "[rpc:call] file-watcher.watch FAIL (1.2ms)",
        watchEnoent("/Users/me/project/.zcode/workflows"),
      ),
    ).toBe("info");
  });

  it("logs a missing Windows-style .zcode\\workflows watch at info", () => {
    expect(
      resolveRpcLogLevel(
        "[rpc:call] file-watcher.watch FAIL (1.2ms)",
        watchEnoent("C:\\Users\\me\\project\\.zcode\\workflows"),
      ),
    ).toBe("info");
  });

  it("keeps ENOENT on other paths, other errors, and other watch calls at warn", () => {
    expect(
      resolveRpcLogLevel(
        "[rpc:call] file-watcher.watch FAIL (1.2ms)",
        watchEnoent("/Users/me/project/src"),
      ),
    ).toBe("warn");
    expect(
      resolveRpcLogLevel(
        "[rpc:call] file-watcher.watch FAIL (1.2ms)",
        new Error("无法监视目录 '/Users/me/project/.zcode/workflows': EACCES: permission denied"),
      ),
    ).toBe("warn");
    expect(
      resolveRpcLogLevel(
        "[rpc:call] file-watcher.unwatch FAIL (1.2ms)",
        watchEnoent("/Users/me/project/.zcode/workflows"),
      ),
    ).toBe("warn");
  });
});
