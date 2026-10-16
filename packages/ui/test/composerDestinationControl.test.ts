// Unified destination control tests (specs/composer-branch-switcher-semantics.md §4):
// flag default on + layout rollback wiring (source contract), worktree intent registration with
// the selected base override, and Task/Base row semantics through the store.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  selectDraftBranchIntent,
  selectWorktreeIntentActive,
  useDraftBranchIntentStore,
} from "@/v4/composer/draftBranchIntent.js";
import {
  COMPOSER_DESTINATION_CONTROL_FLAG,
  readComposerDestinationControlEnabled,
} from "@/v4/composer/ComposerDestinationControl.js";
import { shouldRenderComposerDestinationControl } from "@/v4/composer/destinationControlVisibility.js";

const WORKSPACE_KEY = "/dev/alpha";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("feature flag", () => {
  it("reads the renderer-local flag (default on; '0' restores the legacy pair)", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    expect(readComposerDestinationControlEnabled()).toBe(true);
    window.localStorage.setItem(COMPOSER_DESTINATION_CONTROL_FLAG, "0");
    expect(readComposerDestinationControlEnabled()).toBe(false);
  });
});

describe("WorkspaceShellLayout rollback wiring (source contract)", () => {
  const source = readFileSync(
    resolve(process.cwd(), "packages/ui/src/app-shell/WorkspaceShellLayout.tsx"),
    "utf8",
  ).replace(/\s+/gu, " ");

  it("renders the unified control only when the flag is on; the old pair remains for rollback", () => {
    expect(source).toContain("canRenderGitDestinationControl && destinationControlEnabled ? (");
    expect(source).toContain("<ComposerDestinationControl");
    // Flag off must keep the legacy controls fully intact.
    expect(source).toContain("<GitBranchSwitcher");
    expect(source).toContain("<ChatEmptyWorktreeTaskToggle");
    expect(source).toContain("canRenderGitDestinationControl ? (");
    expect(source).toContain("!destinationControlEnabled ? (");
  });
});

describe("Git destination visibility follows the selected workspace", () => {
  const visible = (
    activeWorkspaceKey: string,
    gitState: {
      workspaceKey: string;
      loading: boolean;
      summary: { isGitAvailable: boolean; isRepository: boolean };
    },
  ) => shouldRenderComposerDestinationControl({ activeWorkspaceKey, gitState });

  it("shows the destination for a confirmed Git project, hides it while the next project's status loads, then shows it for the next Git project", () => {
    expect(
      visible("/projects/one", {
        workspaceKey: "/projects/one",
        loading: false,
        summary: { isGitAvailable: true, isRepository: true },
      }),
    ).toBe(true);

    expect(
      visible("/projects/plain", {
        workspaceKey: "/projects/plain",
        loading: true,
        summary: { isGitAvailable: false, isRepository: false },
      }),
    ).toBe(false);
    expect(
      visible("/projects/plain", {
        workspaceKey: "/projects/plain",
        loading: false,
        summary: { isGitAvailable: true, isRepository: false },
      }),
    ).toBe(false);

    expect(
      visible("/projects/three", {
        workspaceKey: "/projects/three",
        loading: false,
        summary: { isGitAvailable: true, isRepository: true },
      }),
    ).toBe(true);
  });

  it("ignores a completed Git response from the previous project", () => {
    expect(
      visible("/projects/plain", {
        workspaceKey: "/projects/one",
        loading: false,
        summary: { isGitAvailable: true, isRepository: true },
      }),
    ).toBe(false);
  });
});

describe("destination semantics through the shared stores", () => {
  it("the switch and the branch intent live in one store: mode toggle keeps the branch value", () => {
    const store = useDraftBranchIntentStore.getState();
    store.setDraftBranchIntent(WORKSPACE_KEY, "feature/x");
    store.setWorktreeIntentActive(WORKSPACE_KEY, true);
    const state = useDraftBranchIntentStore.getState();
    // In worktree mode the same selection is reinterpreted as the base (Task ↔ Base relabel).
    expect(selectDraftBranchIntent(state, WORKSPACE_KEY)).toBe("feature/x");
    expect(selectWorktreeIntentActive(state, WORKSPACE_KEY)).toBe(true);
    store.setWorktreeIntentActive(WORKSPACE_KEY, false);
    store.clearDraftBranchIntent(WORKSPACE_KEY);
    expect(selectDraftBranchIntent(useDraftBranchIntentStore.getState(), WORKSPACE_KEY)).toBeNull();
  });

  it("withdraws a queued worktree when project mode is selected", async () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/v4/composer/ComposerDestinationControl.tsx"),
      "utf8",
    );
    const toggle = source.slice(source.indexOf("aria-checked={worktreeActive}"));
    expect(toggle).toContain("setWorktreeIntentActive(workspaceKey, !worktreeActive)");
    expect(toggle).toContain('pipeline?.status === "creating" || pipeline?.status === "ready"');
    expect(toggle).toContain("getState().withdraw(workspaceKey)");
    expect(source).toContain("!pipeline.orphaned");
  });
});

describe("workspace isolation (source contract)", () => {
  const source = readFileSync(
    resolve(process.cwd(), "packages/ui/src/v4/composer/ComposerDestinationControl.tsx"),
    "utf8",
  );

  it("resets cached branch state when the workspace changes (live bug: previous project's branch became the next project's worktree base)", () => {
    // The shell header stays mounted across workspace tabs; the reset keyed by workspaceKey is
    // what drops the previous project's cached branch list, base pick, and open views.
    expect(source).toContain("setBaseBranch(null);");
    expect(source).toContain("setBranchesResult(null);");
    expect(source).toContain("setBranchListFailed(false);");
    expect(source).toContain("}, [workspaceKey]);");
  });

  it("derives the automatic base from the live git summary, never the cached branch list", () => {
    // The cached list can outlive a branch switch or a project switch; only the live summary
    // may name the base. HEAD is the fallback solely when no branch can be named (detached).
    expect(source).not.toContain("branchesResult?.currentBranchName");
    expect(source).toContain("baseBranch ?? (headDefault ? undefined : currentBranchName)");
    expect(source).toContain("baseFromHeadDefault: headDefault");
  });
});

// The component render itself is covered by the shared harness pattern in
// chatEmptyWorktreeTaskToggle.test.ts (same providers/mocks); this file pins the flag + wiring +
// store semantics that the harness would not catch. beginCreation base override is asserted in the
// pipeline-level tests via the store params.
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
