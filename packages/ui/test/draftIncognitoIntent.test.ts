import { afterEach, describe, expect, it } from "vitest";
import { INCOGNITO_LOCKDOWN_PROFILE, resolveIncognitoDefaults } from "@zcode/shared";
import {
  resolveDraftIncognitoProfile,
  selectDraftIncognito,
  useDraftIncognitoIntentStore,
} from "@/v4/composer/draftIncognitoIntent.js";

// specs/incognito-session.md "Draft state": UI-local intent per workspace identity key.
describe("draft incognito intent", () => {
  afterEach(() => useDraftIncognitoIntentStore.setState({ capabilitiesByWorkspaceKey: {} }));

  it("starts from the Settings defaults and resolves the frozen profile", () => {
    const store = useDraftIncognitoIntentStore.getState();
    expect(resolveDraftIncognitoProfile("ws")).toBeUndefined();

    store.activate("ws", { ...resolveIncognitoDefaults(undefined), mcp: true });
    store.setCapability("ws", "skills", true);

    expect(resolveDraftIncognitoProfile("ws")).toEqual({
      ...INCOGNITO_LOCKDOWN_PROFILE,
      mcp: true,
      skills: true,
    });
    expect(selectDraftIncognito(useDraftIncognitoIntentStore.getState(), "other")).toBeNull();
  });

  it("keeps per-session deviations when activated again and clears on deactivate", () => {
    const store = useDraftIncognitoIntentStore.getState();
    store.activate("ws", resolveIncognitoDefaults(undefined));
    store.setCapability("ws", "hooks", true);
    store.activate("ws", resolveIncognitoDefaults({ hooks: false }));
    expect(resolveDraftIncognitoProfile("ws")?.hooks).toBe(true);

    store.deactivate("ws");
    expect(resolveDraftIncognitoProfile("ws")).toBeUndefined();
    store.setCapability("ws", "hooks", true);
    expect(resolveDraftIncognitoProfile("ws")).toBeUndefined();
  });
});
