import { describe, expect, it, vi } from "vitest";
import type { CommandAck, ExternalAgentConfigOption } from "@zcode/shared/zcode-protocol-v4";
import {
  filterExternalAgentConfigValues,
  nextExternalAgentConfigValue,
  resolveExternalAgentComposerState,
  resolveExternalAgentId,
  selectExternalAgentComposerOptions,
  sendExternalAgentConfigOption,
} from "@/v4/composer/externalAgentConfig.js";

function option(
  id: string,
  category: string | null,
  values: string[],
  currentValue = values[0] ?? "",
): ExternalAgentConfigOption {
  return {
    id,
    name: id,
    description: null,
    category,
    currentValue,
    options: values.map((value) => ({ value, name: value, description: null, group: null })),
  };
}

function ack(status: CommandAck["status"], reasonCode?: string): CommandAck {
  return { commandId: "c1", status, revisionAtDecision: 1, ...(reasonCode ? { reasonCode } : {}) };
}

describe("externalAgentConfig helpers", () => {
  it("detects ACP providers by the acp: prefix only", () => {
    expect(resolveExternalAgentId("acp:claude")).toBe("claude");
    expect(resolveExternalAgentId("acp:")).toBeNull();
    expect(resolveExternalAgentId("glm")).toBeNull();
    expect(resolveExternalAgentId(undefined)).toBeNull();
  });

  it("selects mode, model and effort by category first, then by id", () => {
    const selected = selectExternalAgentComposerOptions([
      option("approval", "mode", ["a", "b"]),
      option("mode", null, ["x"]),
      option("model", null, ["m1"]),
      option("effort", null, ["low", "high"]),
      option("other", "custom", ["z"]),
      option("empty", "thought_level", []),
    ]);
    expect(selected.mode?.id).toBe("approval");
    expect(selected.model?.id).toBe("model");
    expect(selected.effort?.id).toBe("effort");
  });

  it("shows the projection for the draft's agent and enables it only for the session's own agent", () => {
    const projection = { agentId: "mock", options: [option("mode", "mode", ["a"])] };
    const base = {
      draftProviderId: "acp:mock",
      sessionId: "s1",
      sessionProviderId: "acp:mock",
      projection,
    };
    expect(resolveExternalAgentComposerState({ ...base, draftProviderId: "glm" })).toBeNull();
    expect(resolveExternalAgentComposerState(base)).toMatchObject({ enabled: true });
    expect(resolveExternalAgentComposerState(base)?.options?.mode?.id).toBe("mode");
    // No projection at all (no catalog and no snapshot): the placeholder state.
    expect(resolveExternalAgentComposerState({ ...base, projection: undefined })).toEqual({
      agentId: "mock",
      options: null,
      draft: false,
      enabled: true,
    });
    // A draft shows the live projection or the catalog, and its choices are local (enabled while options exist).
    const beforeMessage = resolveExternalAgentComposerState({ ...base, sessionId: null });
    expect(beforeMessage?.options?.mode?.id).toBe("mode");
    expect(beforeMessage).toMatchObject({ draft: true, enabled: true });
    const fromCatalog = resolveExternalAgentComposerState({
      ...base,
      sessionId: null,
      projection: undefined,
      catalog: projection.options,
      draftChoices: { mode: "a" },
    });
    expect(fromCatalog?.options?.mode?.currentValue).toBe("a");
    expect(fromCatalog).toMatchObject({ draft: true, enabled: true });
    const otherModel = resolveExternalAgentComposerState({ ...base, sessionProviderId: "glm" });
    expect(otherModel?.options?.mode?.id).toBe("mode");
    expect(otherModel?.enabled).toBe(false);
    // A projection of another agent is not shown for this draft.
    expect(
      resolveExternalAgentComposerState({ ...base, draftProviderId: "acp:other" })?.options,
    ).toBeNull();
  });

  it("cycles values and filters by name", () => {
    expect(nextExternalAgentConfigValue(option("mode", "mode", ["a", "b", "c"], "c"))).toBe("a");
    expect(nextExternalAgentConfigValue(option("mode", "mode", ["a", "b"], "gone"))).toBe("a");
    const values = option("model", "model", ["Sonnet 4", "Opus 4", "Haiku"]).options;
    expect(filterExternalAgentConfigValues(values, " opus ").map((value) => value.value)).toEqual([
      "Opus 4",
    ]);
    expect(filterExternalAgentConfigValues(values, "")).toHaveLength(3);
  });
});

describe("sendExternalAgentConfigOption", () => {
  it("dispatches setExternalAgentConfigOption to the session with the matching payload", async () => {
    const dispatch = vi.fn(async () => ack("accepted"));
    await expect(sendExternalAgentConfigOption(dispatch, "s1", "mode", "plan")).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalledWith(
      "setExternalAgentConfigOption",
      { sessionId: "s1", configId: "mode", value: "plan" },
      "s1",
    );
  });

  it("is silent for a no-op such as config.unchanged", async () => {
    const onFailure = vi.fn();
    const dispatch = vi.fn(async () => ack("noop", "config.unchanged"));
    await expect(
      sendExternalAgentConfigOption(dispatch, "s1", "mode", "plan", onFailure),
    ).resolves.toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it.each([
    ["config.notAvailable", "chat.toolbar.externalAgent.error.notAvailable"],
    ["config.invalid", "chat.toolbar.externalAgent.error.invalid"],
    ["config.notExternalAgent", "chat.toolbar.externalAgent.error.notExternalAgent"],
    ["fault.unknown", "chat.toolbar.externalAgent.error.failed"],
  ])("maps a failed ACK with %s to a toast message", async (reasonCode, messageId) => {
    const onFailure = vi.fn();
    const dispatch = vi.fn(async () => ack("failed", reasonCode));
    await expect(
      sendExternalAgentConfigOption(dispatch, "s1", "mode", "plan", onFailure),
    ).resolves.toBe(messageId);
    expect(onFailure).toHaveBeenCalledWith({ reasonCode, status: "failed" });
  });

  it("catches a transport error (offline) and reports the generic failure", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("remote workspace disconnected");
    });
    await expect(sendExternalAgentConfigOption(dispatch, "s1", "mode", "plan")).resolves.toBe(
      "chat.toolbar.externalAgent.error.failed",
    );
  });
});
