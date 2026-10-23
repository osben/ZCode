// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  getV4ComposerDraftStorageKey,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";

// ISSUE-035: an explicit model pick in an existing session survives an empty text draft.
// Only the explicit marker keeps an empty record; snapshot-inherited models and new-task drafts do not.
const model = { providerId: "provider", modelId: "model-b" };
const explicitPick = {
  text: "",
  mode: "build" as const,
  modelSelection: model,
  modelSelectionPicked: true as const,
};
const inheritedModel = { text: "", mode: "build" as const, modelSelection: model };

afterEach(() => {
  window.localStorage.clear();
});

describe("existing-session explicit model pick without text (ISSUE-035)", () => {
  it("MP01 keeps an empty existing-session draft that carries the explicit pick", () => {
    persistV4ComposerDraft("/mp01", undefined, "session-1", explicitPick);

    expect(readV4ComposerDraft("/mp01", undefined, "session-1")).toMatchObject({
      text: "",
      modelSelection: model,
      modelSelectionPicked: true,
    });
  });

  it("MP04 does not store an empty existing-session draft whose model was only inherited", () => {
    persistV4ComposerDraft("/mp04", undefined, "session-1", inheritedModel);

    expect(readV4ComposerDraft("/mp04", undefined, "session-1")).toBeNull();
  });

  it("MP05 an empty record is removed once the pick marker is cleared", () => {
    persistV4ComposerDraft("/mp05", undefined, "session-1", explicitPick);
    persistV4ComposerDraft("/mp05", undefined, "session-1", inheritedModel);

    expect(readV4ComposerDraft("/mp05", undefined, "session-1")).toBeNull();
  });

  it("MP06 an unaccepted pick keeps its marker and record", () => {
    persistV4ComposerDraft("/mp06", undefined, "session-1", explicitPick);
    persistV4ComposerDraft("/mp06", undefined, "session-1", {
      ...explicitPick,
      mode: "edit",
    });

    expect(readV4ComposerDraft("/mp06", undefined, "session-1")).toMatchObject({
      modelSelection: model,
      modelSelectionPicked: true,
      mode: "edit",
    });
  });

  it("MP07 an empty new-task draft with a pick is still not stored", () => {
    persistV4ComposerDraft("/mp07", undefined, V4_DRAFT_SCOPE_ROOT, explicitPick);

    expect(readV4ComposerDraft("/mp07", undefined, V4_DRAFT_SCOPE_ROOT)).toBeNull();
  });

  it("MP09 records are isolated by workspace identity", () => {
    persistV4ComposerDraft("/mp09", "remote:host-a", "session-1", explicitPick);

    expect(readV4ComposerDraft("/mp09", "remote:host-b", "session-1")).toBeNull();
    expect(readV4ComposerDraft("/mp09", "remote:host-a", "session-1")).toMatchObject({
      modelSelection: model,
    });
  });

  it("a pick without a valid model is not kept on read", () => {
    window.localStorage.setItem(
      getV4ComposerDraftStorageKey("/mp-invalid"),
      JSON.stringify({
        version: 1,
        scopes: {
          "session-1": { text: "", modelSelectionPicked: true, updatedAt: 1 },
        },
      }),
    );

    expect(readV4ComposerDraft("/mp-invalid", undefined, "session-1")).toBeNull();
  });
});
