import { afterEach, describe, expect, it } from "vitest";
import { INCOGNITO_LOCKDOWN_PROFILE, resolveIncognitoDefaults } from "@zcode/shared";
import {
  selectDraftIncognito,
  selectDraftIncognitoGeneration,
  useDraftIncognitoIntentStore,
} from "@/v4/composer/draftIncognitoIntent.js";

// specs/incognito-session.md "Draft state": UI-local intent per workspace identity key, plus the
// intent generation that keeps async activation and send cleanup on the draft that caused them.
describe("draft incognito intent", () => {
  afterEach(() =>
    useDraftIncognitoIntentStore.setState({
      capabilitiesByWorkspaceKey: {},
      generationByWorkspaceKey: {},
    }),
  );

  it("starts from the Settings defaults and freezes the profile for submission", () => {
    const store = useDraftIncognitoIntentStore.getState();
    expect(store.captureForSubmission("ws")).toBeUndefined();

    store.activate("ws", { ...resolveIncognitoDefaults(undefined), mcp: true });
    store.setCapability("ws", "skills", true);

    // Generations so far: the no-intent capture above (1), activate (2), setCapability (3).
    expect(store.captureForSubmission("ws")).toEqual({
      profile: { ...INCOGNITO_LOCKDOWN_PROFILE, mcp: true, skills: true },
      generation: 4,
    });
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "other")).toBeNull();
  });

  it("keeps per-session deviations when activated again and clears on deactivate", () => {
    const store = useDraftIncognitoIntentStore.getState();
    store.activate("ws", resolveIncognitoDefaults(undefined));
    store.setCapability("ws", "hooks", true);
    store.activate("ws", resolveIncognitoDefaults({ hooks: false }));
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "ws")?.hooks).toBe(true);

    store.deactivate("ws");
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "ws")).toBeNull();
    store.setCapability("ws", "hooks", true);
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "ws")).toBeNull();
  });

  it("applies a defaults read only when its captured generation is still current", () => {
    const store = useDraftIncognitoIntentStore.getState();
    const generation = selectDraftIncognitoGeneration(
      useDraftIncognitoIntentStore.getState(),
      "ws",
    );
    store.deactivate("ws");
    store.activateIfCurrent("ws", resolveIncognitoDefaults({ mcp: true }), generation);
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "ws")).toBeNull();

    const nextGeneration = selectDraftIncognitoGeneration(
      useDraftIncognitoIntentStore.getState(),
      "ws",
    );
    store.activateIfCurrent("ws", resolveIncognitoDefaults({ mcp: true }), nextGeneration);
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "ws")).toEqual(
      resolveIncognitoDefaults({ mcp: true }),
    );
  });

  it("discards a pending activation when its draft was submitted before the read resolved", () => {
    const store = useDraftIncognitoIntentStore.getState();
    const generation = selectDraftIncognitoGeneration(
      useDraftIncognitoIntentStore.getState(),
      "ws",
    );
    // The draft is sent while the defaults read is still pending; the send consumes the draft.
    expect(store.captureForSubmission("ws")).toBeUndefined();
    store.activateIfCurrent("ws", resolveIncognitoDefaults({ mcp: true }), generation);
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "ws")).toBeNull();
  });

  it("releases the intent after a send only when no newer draft touched it meanwhile", () => {
    const store = useDraftIncognitoIntentStore.getState();
    store.activate("ws", resolveIncognitoDefaults(undefined));
    const submission = store.captureForSubmission("ws");
    expect(submission).toBeDefined();

    // A newer draft changed capabilities while the send was in flight.
    store.setCapability("ws", "mcp", true);
    store.releaseAfterSend("ws", submission!.generation);
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "ws")).not.toBeNull();

    // Nothing intervened: the send cleanup consumes the intent for the next draft.
    const quiet = store.captureForSubmission("ws");
    store.releaseAfterSend("ws", quiet!.generation);
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "ws")).toBeNull();
  });

  it("keeps the intent a newer draft re-armed after an older send completed", () => {
    const store = useDraftIncognitoIntentStore.getState();
    store.activate("ws", resolveIncognitoDefaults(undefined));
    const first = store.captureForSubmission("ws");
    // The newer draft toggles the intent off and on again while the first send is in flight.
    store.deactivate("ws");
    store.activate("ws", resolveIncognitoDefaults({ mcp: true }));

    store.releaseAfterSend("ws", first!.generation);
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "ws")).toEqual(
      resolveIncognitoDefaults({ mcp: true }),
    );
  });
});
