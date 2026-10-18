// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { GitPaneChangeCard } from "@/GitPaneChangeCard.js";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

afterEach(cleanup);

// Mirrors what packages/services/src/git/gitService.ts returns for a porcelain
// "UU" (unmerged) entry during a merge conflict: section "conflicted", zero
// +/- stats, staged source excludes conflicted entries.
function renderConflictedChangeCard(): void {
  const change: GitPaneFileChange = {
    path: "/repo/src/lib.txt",
    repoRelativePath: "src/lib.txt",
    workspaceRelativePath: "src/lib.txt",
    x: "U",
    y: "U",
    kind: "modified",
    section: "conflicted",
    added: 0,
    removed: 0,
    isStaged: false,
    isUntracked: false,
    isConflicted: true,
    diff: null,
  };

  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(GitPaneChangeCard, {
        change,
        contextMenuLabels: {
          copyAbsolutePath: "Copy absolute path",
          copyRelativePath: "Copy relative path",
          revealInFileManager: "Reveal in file manager",
          revealInFileTree: "Reveal in file tree",
        },
        diffState: null,
        isDiffLoading: false,
        isExpanded: false,
        canRevealInFileManager: false,
        codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
        resolvedTheme: "light",
        onCopyAbsolutePath: () => {},
        onCopyRelativePath: () => {},
        onOpenChange: () => {},
        onRevealInFileManager: () => {},
      }),
    ),
  );
}

describe("review pane conflicted file badge", () => {
  it.fails("BUG-GWT-011: renders the Conflicted badge on a UU (unmerged) file row", () => {
    renderConflictedChangeCard();

    // The row itself renders, so a failure below is about the missing badge, not the harness.
    expect(screen.getByText("lib.txt")).toBeTruthy();
    expect(screen.getByText("+0")).toBeTruthy();
    expect(screen.getByText("-0")).toBeTruthy();

    // docs/git/requirements.md#4.1 (File List): non "Not staged" items can display
    // a status badge, e.g. Untracked, Conflicted, Staged. Locale keys
    // "git.section.conflicted" / "git.kind.conflicted" already exist in every locale
    // but are never used by the Review pane row (see
    // docs/testing/git-worktree-qa/bugs/BUG-GWT-011.md).
    expect(screen.getByText("Conflicted")).toBeTruthy();
  });
});
