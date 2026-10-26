import { describe, expect, it, vi } from "vitest";
import type { CommandAck, ExternalAgentConfigOption } from "@zcode/shared/zcode-protocol-v4";
import {
  claimDraftExternalAgentChoices,
  draftExternalAgentChoicesOf,
  restoreDraftExternalAgentChoices,
  sendClaimedDraftExternalAgentChoices,
  sendDraftExternalAgentChoices,
  setDraftExternalAgentChoice,
  takeDraftExternalAgentChoices,
  filterExternalAgentConfigValues,
  hideExternalAgentModels,
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

  // Draft choices belong to the draft session that the first submission uses. Switching the task (another draft) must
  // not send an abandoned draft's choices, and the draft's own choices are removed once they are sent.
  it("keeps draft choices per draft: a switched task sends none of another draft's choices", () => {
    const state = setDraftExternalAgentChoice({}, "draft-A", "mock", "mode", "plan");

    expect(draftExternalAgentChoicesOf(state, "draft-B", "mock")).toBeUndefined();
    expect(draftExternalAgentChoicesOf(state, "draft-A", "mock")).toEqual({ mode: "plan" });
  });

  it("applies the same draft's choices and removes them once they are sent", () => {
    let state = setDraftExternalAgentChoice({}, "draft-A", "mock", "mode", "plan");
    state = setDraftExternalAgentChoice(state, "draft-A", "mock", "model", "fast");
    state = setDraftExternalAgentChoice(state, "draft-A", "other", "mode", "ask");

    expect(draftExternalAgentChoicesOf(state, "draft-A", "mock")).toEqual({
      mode: "plan",
      model: "fast",
    });

    const sent = takeDraftExternalAgentChoices(state, "draft-A");
    expect(draftExternalAgentChoicesOf(sent, "draft-A", "mock")).toBeUndefined();
    expect(draftExternalAgentChoicesOf(sent, "draft-A", "other")).toBeUndefined();
    // The state is immutable: the earlier value still holds the choices.
    expect(draftExternalAgentChoicesOf(state, "draft-A", "mock")).toEqual({
      mode: "plan",
      model: "fast",
    });
  });

  // Worktree drafts create a separate prepared session. The choices are read from the draft they were made in and sent to
  // the session that receives the first submission, never to the draft.
  it("worktree draft: reads the draft's choices and sends them to the created session", async () => {
    const state = setDraftExternalAgentChoice({}, "draft-A", "mock", "mode", "plan");
    const send = vi.fn(async () => null);

    const outcome = await sendDraftExternalAgentChoices({
      state,
      draftSessionId: "draft-A",
      agentId: "mock",
      targetSessionId: "worktree-session-1",
      send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("worktree-session-1", "mode", "plan");
    expect(outcome).toEqual({ sent: true, refusedMessageId: null });
  });

  it("sends nothing when the draft made no choices, and reports a refusal without clearing", async () => {
    const send = vi.fn(async () => "chat.toolbar.externalAgent.error.invalid");
    const state = setDraftExternalAgentChoice({}, "draft-A", "mock", "mode", "yolo");

    expect(
      await sendDraftExternalAgentChoices({
        state,
        draftSessionId: "draft-B",
        agentId: "mock",
        targetSessionId: "session-B",
        send,
      }),
    ).toEqual({ sent: false, refusedMessageId: null });
    expect(send).not.toHaveBeenCalled();

    const refused = await sendDraftExternalAgentChoices({
      state,
      draftSessionId: "draft-A",
      agentId: "mock",
      targetSessionId: "session-A",
      send,
    });
    expect(refused).toEqual({
      sent: false,
      refusedMessageId: "chat.toolbar.externalAgent.error.invalid",
    });
  });
});

describe("draft choice lifecycle", () => {
  const send = (sessionId: string | null) => ({ sessionId });

  it("never takes a draft's choices for a bound task (draft to an existing same-agent task sends nothing)", () => {
    const state = setDraftExternalAgentChoice({}, "draft-key", "opencode", "mode", "plan");
    const { state: next, claim } = claimDraftExternalAgentChoices({
      state,
      draftKey: "draft-key",
      agentId: "opencode",
      ...send("existing-task"),
    });
    expect(claim).toBeNull();
    expect(next).toBe(state);
  });

  it("takes a draft's choices once: a second claim after the first sees nothing", () => {
    const state = setDraftExternalAgentChoice({}, "draft-key", "opencode", "mode", "plan");
    const first = claimDraftExternalAgentChoices({
      state,
      draftKey: "draft-key",
      agentId: "opencode",
      ...send(null),
    });
    expect(first.claim?.choices).toEqual({ mode: "plan" });
    const second = claimDraftExternalAgentChoices({
      state: first.state,
      draftKey: "draft-key",
      agentId: "opencode",
      ...send(null),
    });
    expect(second.claim).toBeNull();
  });

  it("does not carry choices into another draft instance of the same project", () => {
    // A new-task entry bumps the draft instance (the composer generation), so the key changes.
    const state = setDraftExternalAgentChoice({}, "scope#1", "opencode", "mode", "plan");
    expect(draftExternalAgentChoicesOf(state, "scope#2", "opencode")).toBeUndefined();
    const { claim } = claimDraftExternalAgentChoices({
      state,
      draftKey: "scope#2",
      agentId: "opencode",
      ...send(null),
    });
    expect(claim).toBeNull();
  });

  it("restores a refused claim without overwriting a choice the user made meanwhile", () => {
    const state = setDraftExternalAgentChoice(
      setDraftExternalAgentChoice({}, "draft-key", "opencode", "mode", "plan"),
      "draft-key",
      "opencode",
      "model",
      "fast",
    );
    const { state: taken, claim } = claimDraftExternalAgentChoices({
      state,
      draftKey: "draft-key",
      agentId: "opencode",
      ...send(null),
    });
    const edited = setDraftExternalAgentChoice(taken, "draft-key", "opencode", "mode", "build");
    const restored = restoreDraftExternalAgentChoices(edited, claim!);
    expect(draftExternalAgentChoicesOf(restored, "draft-key", "opencode")).toEqual({
      mode: "build",
      model: "fast",
    });
  });

  it("claims only the claiming agent's choices and keeps the other agents' choices, also across a restore", () => {
    const state = setDraftExternalAgentChoice(
      setDraftExternalAgentChoice({}, "draft-key", "opencode", "mode", "plan"),
      "draft-key",
      "cursor",
      "model",
      "fast",
    );
    const { state: taken, claim } = claimDraftExternalAgentChoices({
      state,
      draftKey: "draft-key",
      agentId: "opencode",
      ...send(null),
    });
    expect(draftExternalAgentChoicesOf(taken, "draft-key", "opencode")).toBeUndefined();
    expect(draftExternalAgentChoicesOf(taken, "draft-key", "cursor")).toEqual({ model: "fast" });
    const restored = restoreDraftExternalAgentChoices(taken, claim!);
    expect(draftExternalAgentChoicesOf(restored, "draft-key", "opencode")).toEqual({
      mode: "plan",
    });
    expect(draftExternalAgentChoicesOf(restored, "draft-key", "cursor")).toEqual({
      model: "fast",
    });
  });

  it("sends a draft's choices exactly once, even when two applies overlap", async () => {
    const state = setDraftExternalAgentChoice({}, "draft-key", "opencode", "mode", "plan");
    const { claim } = claimDraftExternalAgentChoices({
      state,
      draftKey: "draft-key",
      agentId: "opencode",
      ...send(null),
    });
    const sent = vi.fn(async () => null);
    await Promise.all([
      sendClaimedDraftExternalAgentChoices({ claim, targetSessionId: "s1", send: sent }),
      sendClaimedDraftExternalAgentChoices({ claim, targetSessionId: "s1", send: sent }),
    ]);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith("s1", "mode", "plan");
    expect(claim?.delivered).toBe(true);
  });

  it("leaves a refused claim undelivered so the caller can restore it", async () => {
    const state = setDraftExternalAgentChoice({}, "draft-key", "opencode", "mode", "plan");
    const { claim } = claimDraftExternalAgentChoices({
      state,
      draftKey: "draft-key",
      agentId: "opencode",
      ...send(null),
    });
    const outcome = await sendClaimedDraftExternalAgentChoices({
      claim,
      targetSessionId: "s1",
      send: async () => "chat.toolbar.externalAgent.error.invalid",
    });
    expect(outcome.refusedMessageId).toBe("chat.toolbar.externalAgent.error.invalid");
    expect(claim?.delivered).toBe(false);
  });
});

// specs/acp-agent-runtime.md "Settings: models and Advanced" (SM2, SM3).
describe("hidden agent models", () => {
  const offered = [
    option("mode", "mode", ["build", "plan"]),
    option("model", "model", ["a", "b", "c"], "a"),
  ];

  it("leaves hidden values out of the model select only", () => {
    const state = resolveExternalAgentComposerState({
      draftProviderId: "acp:opencode",
      sessionId: null,
      sessionProviderId: null,
      projection: null,
      catalog: offered,
      hiddenModels: ["b", "build"],
    });
    expect(state?.options?.model?.options.map((value) => value.value)).toEqual(["a", "c"]);
    expect(state?.options?.mode?.options.map((value) => value.value)).toEqual(["build", "plan"]);
  });

  it("never hides the current value", () => {
    const state = resolveExternalAgentComposerState({
      draftProviderId: "acp:opencode",
      sessionId: null,
      sessionProviderId: null,
      projection: null,
      catalog: offered,
      draftChoices: { model: "b" },
      hiddenModels: ["b", "c"],
    });
    expect(state?.options?.model?.currentValue).toBe("b");
    expect(state?.options?.model?.options.map((value) => value.value)).toEqual(["a", "b"]);
  });

  it("returns the selection unchanged when nothing is hidden", () => {
    const selected = selectExternalAgentComposerOptions(offered);
    expect(hideExternalAgentModels(selected, [])).toBe(selected);
    expect(hideExternalAgentModels(selected, ["unknown"])).toBe(selected);
  });
});
