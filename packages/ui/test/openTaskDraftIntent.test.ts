import { describe, expect, it, vi } from "vitest";
import { applyOpenTaskDraft } from "@/root/openTaskDraftIntent.js";

function createDeps(overrides: { allowOpenWorkspace?: boolean; tabOpen?: boolean } = {}) {
  const calls: string[] = [];
  const deps = {
    allowOpenWorkspace: overrides.allowOpenWorkspace ?? true,
    openWorkspacePath: vi.fn(async (path: string) => {
      calls.push(`open:${path}`);
    }),
    activateTabByPath: vi.fn((path: string) => {
      calls.push(`activate:${path}`);
      return overrides.tabOpen ?? true;
    }),
    startDraftInWorkspace: vi.fn((path: string) => {
      calls.push(`draft:${path}`);
    }),
    requestComposerTextInsert: vi.fn(
      (path: string, text: string, _identity?: string, _mention?: unknown, mode?: string) => {
        calls.push(`insert:${path}:${text}:${mode}`);
        return 1;
      },
    ),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  return { deps, calls };
}

describe("applyOpenTaskDraft", () => {
  it("opens the workspace, starts a fresh draft, then inserts the text without sending", async () => {
    const { deps, calls } = createDeps();

    await expect(
      applyOpenTaskDraft({ path: "/work/proj", text: "Сделай план" }, deps),
    ).resolves.toBe("inserted");

    expect(calls).toEqual([
      "open:/work/proj",
      "activate:/work/proj",
      "draft:/work/proj",
      "insert:/work/proj:Сделай план:prepend-text",
    ]);
  });

  it("ignores the request when opening workspaces is not allowed", async () => {
    const { deps, calls } = createDeps({ allowOpenWorkspace: false });

    await expect(applyOpenTaskDraft({ path: "/work/proj", text: "x" }, deps)).resolves.toBe(
      "ignored",
    );

    expect(calls).toEqual([]);
    expect(deps.logger.info).toHaveBeenCalled();
  });

  it("does not insert when the workspace did not end up as a tab in this window", async () => {
    const { deps, calls } = createDeps({ tabOpen: false });

    await expect(applyOpenTaskDraft({ path: "/work/proj", text: "x" }, deps)).resolves.toBe(
      "workspace-unavailable",
    );

    expect(calls).toEqual(["open:/work/proj", "activate:/work/proj"]);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("never logs the task text", async () => {
    const { deps } = createDeps();

    await applyOpenTaskDraft({ path: "/work/proj", text: "super-secret-text" }, deps);

    expect(
      JSON.stringify([deps.logger.info.mock.calls, deps.logger.warn.mock.calls]),
    ).not.toContain("super-secret-text");
  });
});
