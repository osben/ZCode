// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  restoreDraftProjectScope,
  useSettledProjectDirectory,
  type ProjectDirectorySnapshot,
} from "@/root/useRootWorkspaceActions.js";
import {
  persistV4ComposerDraft,
  readComposerWorkspaceScope,
  readV4ComposerDraft,
  rememberComposerWorkspaceScope,
  resolveComposerScope,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";

const path = "/cwd";
const identity = "remote:server:s:/cwd";
const ns = "mobile";
const projectScope = resolveComposerScope("gone", identity, ns);
const globalScope = resolveComposerScope(null, identity, ns);

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("restoreDraftProjectScope", () => {
  it("falls back to the null scope when the persisted project is not in the directory", () => {
    rememberComposerWorkspaceScope(path, identity, projectScope);
    persistV4ComposerDraft(path, identity, V4_DRAFT_SCOPE_ROOT, { text: "unsent" }, projectScope);

    const scope = restoreDraftProjectScope({
      workspacePath: path,
      workspaceIdentity: identity,
      clientNamespace: ns,
      scope: projectScope,
      projectIds: new Set(["other-project"]),
    });

    expect(scope.projectId).toBeNull();
    expect(readComposerWorkspaceScope(path, identity, ns)?.projectId).toBeNull();
    expect(readV4ComposerDraft(path, identity, V4_DRAFT_SCOPE_ROOT, globalScope)?.text).toBe(
      "unsent",
    );
  });

  it("keeps a global null-scope draft that already exists instead of overwriting it", () => {
    persistV4ComposerDraft(path, identity, V4_DRAFT_SCOPE_ROOT, { text: "stale" }, projectScope);
    persistV4ComposerDraft(path, identity, V4_DRAFT_SCOPE_ROOT, { text: "global" }, globalScope);

    restoreDraftProjectScope({
      workspacePath: path,
      workspaceIdentity: identity,
      clientNamespace: ns,
      scope: projectScope,
      projectIds: new Set(),
    });

    expect(readV4ComposerDraft(path, identity, V4_DRAFT_SCOPE_ROOT, globalScope)?.text).toBe(
      "global",
    );
  });

  it("keeps the persisted project when the directory contains it", () => {
    rememberComposerWorkspaceScope(path, identity, projectScope);
    persistV4ComposerDraft(path, identity, V4_DRAFT_SCOPE_ROOT, { text: "unsent" }, projectScope);

    const scope = restoreDraftProjectScope({
      workspacePath: path,
      workspaceIdentity: identity,
      clientNamespace: ns,
      scope: projectScope,
      projectIds: new Set(["gone"]),
    });

    expect(scope).toBe(projectScope);
    expect(readComposerWorkspaceScope(path, identity, ns)?.projectId).toBe("gone");
    expect(readV4ComposerDraft(path, identity, V4_DRAFT_SCOPE_ROOT, projectScope)?.text).toBe(
      "unsent",
    );
  });

  it("never rewrites a null-scope persisted intent", () => {
    const scope = restoreDraftProjectScope({
      workspacePath: path,
      workspaceIdentity: identity,
      clientNamespace: ns,
      scope: globalScope,
      projectIds: new Set(),
    });
    expect(scope.projectId).toBeNull();
  });
});

describe("useSettledProjectDirectory", () => {
  it("waits for the directory to settle, then resolves with the settled snapshot", async () => {
    const loading: ProjectDirectorySnapshot = { loading: true, error: null, projects: [] };
    const settled: ProjectDirectorySnapshot = {
      loading: false,
      error: null,
      projects: [{ id: "gone" }],
    };
    const { result, rerender } = renderHook(
      ({ directory }: { directory: ProjectDirectorySnapshot | null }) =>
        useSettledProjectDirectory(directory),
      { initialProps: { directory: loading } },
    );

    let resolved: ProjectDirectorySnapshot | null | undefined;
    const pending = result.current().then((value) => {
      resolved = value;
    });
    await Promise.resolve();
    expect(resolved).toBeUndefined();

    await act(async () => {
      rerender({ directory: settled });
    });
    await pending;
    expect(resolved).toBe(settled);
  });

  it("resolves immediately when the directory is already settled", async () => {
    const settled: ProjectDirectorySnapshot = { loading: false, error: null, projects: [] };
    const { result } = renderHook(() => useSettledProjectDirectory(settled));
    await expect(result.current()).resolves.toBe(settled);
  });
});
