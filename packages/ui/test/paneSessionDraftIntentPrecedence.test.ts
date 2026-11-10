// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  persistPaneSession,
  willRestorePersistedPaneSession,
} from "../src/v4/usePaneSessionPersistence.js";

afterEach(() => {
  localStorage.clear();
});

const restorable = {
  workspacePath: "/local/path",
  active: true,
  rendererReload: false,
  restoreOnStartup: true,
};

describe("pane session precedence over the remembered draft intent", () => {
  it("reads the persisted pane session under the workspace identity key", () => {
    persistPaneSession("remote-identity", "sess_1");
    expect(
      willRestorePersistedPaneSession({ ...restorable, workspaceIdentity: "remote-identity" }),
    ).toBe(true);
    expect(willRestorePersistedPaneSession(restorable)).toBe(false);
  });

  it("falls back to the workspace path when the identity is blank", () => {
    persistPaneSession("/local/path", "sess_2");
    expect(willRestorePersistedPaneSession({ ...restorable, workspaceIdentity: "  " })).toBe(true);
  });

  it("is false once the pane went back to a draft", () => {
    persistPaneSession("/local/path", "sess_3");
    persistPaneSession("/local/path", null);
    expect(willRestorePersistedPaneSession(restorable)).toBe(false);
  });

  it("restores only the active tab on a reload or a startup restore", () => {
    persistPaneSession("/local/path", "sess_4");
    expect(willRestorePersistedPaneSession({ ...restorable, active: false })).toBe(false);
    expect(
      willRestorePersistedPaneSession({
        ...restorable,
        rendererReload: false,
        restoreOnStartup: false,
      }),
    ).toBe(false);
    expect(
      willRestorePersistedPaneSession({
        ...restorable,
        rendererReload: true,
        restoreOnStartup: false,
      }),
    ).toBe(true);
  });
});
