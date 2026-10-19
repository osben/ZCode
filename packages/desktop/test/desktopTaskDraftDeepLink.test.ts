import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("resolveTaskDraftText", () => {
  it("returns the inline prompt unchanged", async () => {
    const { resolveTaskDraftText } = await import("../src/main/desktopTaskDraftDeepLink.js");
    const project = makeDir("zcode-task-project-");

    await expect(
      resolveTaskDraftText({ projectPath: project, prompt: "Сделай план\n- шаг 1" }),
    ).resolves.toEqual({ ok: true, text: "Сделай план\n- шаг 1" });
  });

  it("rejects blank and over-limit inline prompts", async () => {
    const { resolveTaskDraftText, TASK_DRAFT_PROMPT_MAX_CHARS } =
      await import("../src/main/desktopTaskDraftDeepLink.js");
    const project = makeDir("zcode-task-project-");

    await expect(resolveTaskDraftText({ projectPath: project, prompt: " \n\t" })).resolves.toEqual({
      ok: false,
      reason: "empty_prompt",
    });
    await expect(
      resolveTaskDraftText({
        projectPath: project,
        prompt: "a".repeat(TASK_DRAFT_PROMPT_MAX_CHARS + 1),
      }),
    ).resolves.toEqual({ ok: false, reason: "prompt_too_long" });
    await expect(
      resolveTaskDraftText({
        projectPath: project,
        prompt: "a".repeat(TASK_DRAFT_PROMPT_MAX_CHARS),
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("reads a UTF-8 promptFile inside the project", async () => {
    const { resolveTaskDraftText } = await import("../src/main/desktopTaskDraftDeepLink.js");
    const project = makeDir("zcode-task-project-");
    mkdirSync(join(project, ".zcode", "handoff"), { recursive: true });
    const file = join(project, ".zcode", "handoff", "план с пробелами.md");
    writeFileSync(file, "# План\n\nСделай ü");

    await expect(resolveTaskDraftText({ projectPath: project, promptFile: file })).resolves.toEqual(
      {
        ok: true,
        text: "# План\n\nСделай ü",
      },
    );
  });

  it("rejects a promptFile outside the project", async () => {
    const { resolveTaskDraftText } = await import("../src/main/desktopTaskDraftDeepLink.js");
    const project = makeDir("zcode-task-project-");
    const elsewhere = makeDir("zcode-task-elsewhere-");
    const file = join(elsewhere, "plan.md");
    writeFileSync(file, "secret");

    await expect(resolveTaskDraftText({ projectPath: project, promptFile: file })).resolves.toEqual(
      {
        ok: false,
        reason: "file_outside_project",
      },
    );
  });

  it("rejects a symlink inside the project that points outside it", async () => {
    const { resolveTaskDraftText } = await import("../src/main/desktopTaskDraftDeepLink.js");
    const project = makeDir("zcode-task-project-");
    const elsewhere = makeDir("zcode-task-elsewhere-");
    const target = join(elsewhere, "secret.txt");
    writeFileSync(target, "secret");
    const link = join(project, "plan.md");
    symlinkSync(target, link);

    await expect(resolveTaskDraftText({ projectPath: project, promptFile: link })).resolves.toEqual(
      {
        ok: false,
        reason: "file_outside_project",
      },
    );
  });

  it("rejects directories, missing files, empty files, oversized files and invalid UTF-8", async () => {
    const { resolveTaskDraftText, TASK_DRAFT_FILE_MAX_BYTES } =
      await import("../src/main/desktopTaskDraftDeepLink.js");
    const project = makeDir("zcode-task-project-");
    mkdirSync(join(project, "dir"));
    writeFileSync(join(project, "empty.md"), "  \n");
    writeFileSync(join(project, "big.md"), Buffer.alloc(TASK_DRAFT_FILE_MAX_BYTES + 1, 0x61));
    writeFileSync(join(project, "bad.md"), Buffer.from([0xff, 0xfe, 0x41]));

    const reason = async (name: string) =>
      resolveTaskDraftText({ projectPath: project, promptFile: join(project, name) });

    await expect(reason("dir")).resolves.toEqual({ ok: false, reason: "file_not_regular" });
    await expect(reason("missing.md")).resolves.toEqual({ ok: false, reason: "file_unreadable" });
    await expect(reason("empty.md")).resolves.toEqual({ ok: false, reason: "empty_prompt" });
    await expect(reason("big.md")).resolves.toEqual({ ok: false, reason: "file_too_large" });
    await expect(reason("bad.md")).resolves.toEqual({ ok: false, reason: "invalid_encoding" });
  });

  it("rejects relative promptFile paths", async () => {
    const { resolveTaskDraftText } = await import("../src/main/desktopTaskDraftDeepLink.js");
    const project = makeDir("zcode-task-project-");

    await expect(
      resolveTaskDraftText({ projectPath: project, promptFile: "plan.md" }),
    ).resolves.toEqual({ ok: false, reason: "file_unreadable" });
  });
});

describe("buildTaskDraftPreview", () => {
  it("keeps short text and truncates long text to the preview limit", async () => {
    const { buildTaskDraftPreview, TASK_DRAFT_PREVIEW_MAX_CHARS } =
      await import("../src/main/desktopTaskDraftDeepLink.js");

    expect(buildTaskDraftPreview("short")).toBe("short");
    const long = buildTaskDraftPreview("x".repeat(TASK_DRAFT_PREVIEW_MAX_CHARS + 50));
    expect(long.length).toBe(TASK_DRAFT_PREVIEW_MAX_CHARS + 1);
    expect(long.endsWith("…")).toBe(true);
  });
});
