// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  hasPersistedPaneSession,
  persistPaneSession,
} from "../src/v4/usePaneSessionPersistence.js";

afterEach(() => {
  localStorage.clear();
});

describe("pane session precedence over the remembered draft intent", () => {
  it("reports a persisted pane session under the workspace identity key", () => {
    persistPaneSession("remote-identity", "sess_1");
    expect(hasPersistedPaneSession("/local/path", "remote-identity")).toBe(true);
    expect(hasPersistedPaneSession("/local/path")).toBe(false);
  });

  it("falls back to the workspace path when the identity is blank", () => {
    persistPaneSession("/local/path", "sess_2");
    expect(hasPersistedPaneSession("/local/path", "  ")).toBe(true);
  });

  it("is false once the pane went back to a draft", () => {
    persistPaneSession("/local/path", "sess_3");
    persistPaneSession("/local/path", null);
    expect(hasPersistedPaneSession("/local/path")).toBe(false);
  });
});
