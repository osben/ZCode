import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QUICK_PROMPT_LIST_LIMIT,
  type QuickPromptBody,
  type QuickPromptProjectRef,
} from "../src/quick-prompts/contract.js";
import { createQuickPromptService } from "../src/quick-prompts/index.js";

// Spec: specs/composer-quick-prompts.md (product rules 2, 12, 13, 16-19; storage and event order).

const P1: QuickPromptProjectRef = { hostId: "local", projectId: "project:one" };
const P2: QuickPromptProjectRef = { hostId: "remote-a", projectId: "project:two" };

function paragraph(...children: unknown[]): unknown {
  return { type: "paragraph", version: 1, children };
}
function text(value: string): unknown {
  return { type: "text", text: value, version: 1 };
}
function mention(category: string, data?: Record<string, unknown>): unknown {
  return { type: "prompt-mention", category, data, text: category, version: 1 };
}
function body(
  markdown = "review the diff",
  nodes: unknown[] = [paragraph(text(markdown))],
): QuickPromptBody {
  return { markdown, nodes: JSON.stringify(nodes) };
}

describe("quick prompt service", () => {
  let root: string;
  let path: string;
  let handles: DatabaseSync[];
  let afterChange: ReturnType<typeof vi.fn>;

  function openConnection(): DatabaseSync {
    const db = new DatabaseSync(path);
    handles.push(db);
    return db;
  }

  function createService(database = openConnection()) {
    return createQuickPromptService({ database: async () => database, afterChange });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-quick-prompts-service-"));
    path = join(root, "tasks-index.sqlite");
    handles = [];
    afterChange = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    for (const db of handles.splice(0)) {
      try {
        db.close();
      } catch {
        // Already closed by the test body.
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  describe("create, read and visibility", () => {
    it("creates a pinned project prompt visible only to its project and in the row snapshot", async () => {
      const service = createService();
      const created = await service.create({
        scope: "project",
        project: P1,
        name: "  Review  ",
        body: body(),
        pinned: true,
      });

      expect(created).toMatchObject({
        scope: "project",
        project: P1,
        name: "Review",
        pinned: true,
        position: 0,
      });
      expect((await service.read({ project: P1 })).projectPrompts.map((p) => p.promptId)).toEqual([
        created.promptId,
      ]);
      const other = await service.read({ project: P2 });
      expect(other.projectPrompts).toEqual([]);
      const none = await service.read({ project: null });
      expect(none).toEqual({ project: null, globals: [], projectPrompts: [] });
    });

    it("creates a global prompt that every project reads with hiddenInProject false", async () => {
      const service = createService();
      const global = await service.create({
        scope: "global",
        project: null,
        name: "Tests",
        body: body("write tests", [paragraph(text("write tests"), mention("commands"))]),
        pinned: true,
      });

      expect(global.project).toBeNull();
      for (const project of [P1, P2, null]) {
        const snapshot = await service.read({ project });
        expect(snapshot.globals).toEqual([
          expect.objectContaining({ promptId: global.promptId, hiddenInProject: false }),
        ]);
      }
      expect(await service.read({ project: P1 })).toMatchObject({ projectPrompts: [] });
    });

    it("returns the stored body markdown and nodes unchanged", async () => {
      const service = createService();
      const stored = body("run e2e", [paragraph(text("run "), mention("commands"))]);
      const created = await service.create({
        scope: "project",
        project: P1,
        name: "E2E",
        body: stored,
        pinned: false,
      });
      expect(created.body).toEqual(stored);
      const [round] = (await service.read({ project: P1 })).projectPrompts;
      expect(round?.body).toEqual(stored);
    });

    it("lists projects that own prompts and ignores globals", async () => {
      const service = createService();
      await service.create({
        scope: "global",
        project: null,
        name: "G",
        body: body(),
        pinned: true,
      });
      await service.create({
        scope: "project",
        project: P2,
        name: "B",
        body: body(),
        pinned: true,
      });
      await service.create({
        scope: "project",
        project: P1,
        name: "A",
        body: body(),
        pinned: true,
      });
      await service.create({
        scope: "project",
        project: P1,
        name: "A2",
        body: body(),
        pinned: true,
      });

      expect(await service.readProjects()).toEqual([P1, P2]);
    });
  });

  describe("validation", () => {
    it("rejects an empty name and an over-long name with stable codes", async () => {
      const service = createService();
      await expect(
        service.create({ scope: "project", project: P1, name: "   ", body: body(), pinned: true }),
      ).rejects.toThrow("quick-prompt.name-required");
      await expect(
        service.create({
          scope: "project",
          project: P1,
          name: "x".repeat(41),
          body: body(),
          pinned: true,
        }),
      ).rejects.toThrow("quick-prompt.name-too-long");
      expect(afterChange).not.toHaveBeenCalled();
    });

    it("rejects a body over the canonical length and nodes that are not a JSON array", async () => {
      const service = createService();
      await expect(
        service.create({
          scope: "project",
          project: P1,
          name: "Long",
          body: { markdown: "x".repeat(8001), nodes: "[]" },
          pinned: true,
        }),
      ).rejects.toThrow("quick-prompt.body-too-long");
      await expect(
        service.create({
          scope: "project",
          project: P1,
          name: "Bad",
          body: { markdown: "x", nodes: "{}" },
          pinned: true,
        }),
      ).rejects.toThrow("quick-prompt.body-nodes-invalid");
      await expect(
        service.create({
          scope: "project",
          project: P1,
          name: "Bad",
          body: { markdown: "x", nodes: "not json" },
          pinned: true,
        }),
      ).rejects.toThrow("quick-prompt.body-nodes-invalid");
    });

    it("rejects an empty or whitespace-only body on create and update, and keeps the stored body", async () => {
      const service = createService();
      await expect(
        service.create({
          scope: "project",
          project: P1,
          name: "Empty",
          body: { markdown: "", nodes: "[]" },
          pinned: true,
        }),
      ).rejects.toThrow("quick-prompt.body-required");
      await expect(
        service.create({
          scope: "global",
          project: null,
          name: "Blank",
          body: { markdown: " \n\t ", nodes: JSON.stringify([paragraph()]) },
          pinned: true,
        }),
      ).rejects.toThrow("quick-prompt.body-required");
      expect(afterChange).not.toHaveBeenCalled();

      const created = await service.create({
        scope: "project",
        project: P1,
        name: "Kept",
        body: body("keep me"),
        pinned: true,
      });
      await expect(
        service.update({
          promptId: created.promptId,
          body: { markdown: "   ", nodes: "[]" },
        }),
      ).rejects.toThrow("quick-prompt.body-required");
      const snapshot = await service.read({ project: P1 });
      expect(snapshot.projectPrompts[0]?.body.markdown).toBe("keep me");
      expect(afterChange).toHaveBeenCalledTimes(1);
    });

    it("keeps scope and project consistent: global has no project, project has one", async () => {
      const service = createService();
      await expect(
        service.create({ scope: "global", project: P1, name: "G", body: body(), pinned: true }),
      ).rejects.toThrow("quick-prompt.scope-mismatch");
      await expect(
        service.create({ scope: "project", project: null, name: "P", body: body(), pinned: true }),
      ).rejects.toThrow("quick-prompt.scope-mismatch");
      expect(afterChange).not.toHaveBeenCalled();
    });
  });

  describe("global body rule (spec rule 12)", () => {
    const blockedNodes: Array<[string, unknown[]]> = [
      ["files", [paragraph(mention("files"))]],
      ["workspace skills", [paragraph(mention("skills", { scope: "workspace" }))]],
      ["sessions", [paragraph(mention("sessions"))]],
      ["subagents", [paragraph(mention("subagents"))]],
      ["whiteboards", [paragraph(mention("whiteboards"))]],
    ];

    it.each(blockedNodes)("rejects a global body with %s", async (_label, nodes) => {
      const service = createService();
      await expect(
        service.create({
          scope: "global",
          project: null,
          name: "G",
          body: body("x", nodes),
          pinned: true,
        }),
      ).rejects.toThrow("quick-prompt.global-mention-blocked");
      expect(afterChange).not.toHaveBeenCalled();
    });

    it("allows commands, plugins and user or plugin skills in a global body", async () => {
      const service = createService();
      const created = await service.create({
        scope: "global",
        project: null,
        name: "G",
        body: body("x", [
          paragraph(
            mention("commands"),
            mention("plugins"),
            mention("skills", { scope: "user" }),
            mention("skills", { scope: "plugin" }),
          ),
        ]),
        pinned: true,
      });
      expect(created.scope).toBe("global");
    });

    it("accepts a project body with any mention", async () => {
      const service = createService();
      await expect(
        service.create({
          scope: "project",
          project: P1,
          name: "P",
          body: body("x", [paragraph(mention("files"), mention("sessions"))]),
          pinned: true,
        }),
      ).resolves.toMatchObject({ scope: "project" });
    });

    it("rejects moving a project prompt with a file mention to global, using its stored body", async () => {
      const service = createService();
      const project = await service.create({
        scope: "project",
        project: P1,
        name: "P",
        body: body("x", [paragraph(mention("files"))]),
        pinned: true,
      });
      await expect(
        service.update({ promptId: project.promptId, scope: "global", project: null }),
      ).rejects.toThrow("quick-prompt.global-mention-blocked");
    });

    it("rejects a body change on a global prompt that adds a project-bound mention", async () => {
      const service = createService();
      const global = await service.create({
        scope: "global",
        project: null,
        name: "G",
        body: body(),
        pinned: true,
      });
      await expect(
        service.update({
          promptId: global.promptId,
          body: body("x", [paragraph(mention("whiteboards"))]),
        }),
      ).rejects.toThrow("quick-prompt.global-mention-blocked");
    });
  });

  describe("limits (spec rule 18)", () => {
    it("allows 50 globals and rejects the 51st, while each project keeps its own 50", async () => {
      const service = createService();
      for (let index = 0; index < QUICK_PROMPT_LIST_LIMIT; index += 1) {
        await service.create({
          scope: "global",
          project: null,
          name: `G${index}`,
          body: body(),
          pinned: true,
        });
      }
      await expect(
        service.create({
          scope: "global",
          project: null,
          name: "overflow",
          body: body(),
          pinned: true,
        }),
      ).rejects.toThrow("quick-prompt.limit-reached");

      for (let index = 0; index < QUICK_PROMPT_LIST_LIMIT; index += 1) {
        await service.create({
          scope: "project",
          project: P1,
          name: `P${index}`,
          body: body(),
          pinned: true,
        });
      }
      await expect(
        service.create({
          scope: "project",
          project: P1,
          name: "overflow",
          body: body(),
          pinned: true,
        }),
      ).rejects.toThrow("quick-prompt.limit-reached");
      await expect(
        service.create({
          scope: "project",
          project: P2,
          name: "other",
          body: body(),
          pinned: true,
        }),
      ).resolves.toMatchObject({ position: 0 });
    });

    it("enforces the limit on duplicate and on a scope change into a full list", async () => {
      const service = createService();
      for (let index = 0; index < QUICK_PROMPT_LIST_LIMIT; index += 1) {
        await service.create({
          scope: "project",
          project: P1,
          name: `P${index}`,
          body: body(),
          pinned: true,
        });
      }
      const globalPrompt = await service.create({
        scope: "global",
        project: null,
        name: "G",
        body: body(),
        pinned: true,
      });
      await expect(
        service.duplicate({ promptId: globalPrompt.promptId, scope: "project", project: P1 }),
      ).rejects.toThrow("quick-prompt.limit-reached");
      await expect(
        service.update({ promptId: globalPrompt.promptId, scope: "project", project: P1 }),
      ).rejects.toThrow("quick-prompt.limit-reached");
    });
  });

  describe("update, scope change and delete", () => {
    it("keeps the position on a rename and appends a moved prompt to the end of the target list", async () => {
      const service = createService();
      const a = await service.create({
        scope: "project",
        project: P1,
        name: "A",
        body: body(),
        pinned: true,
      });
      const b = await service.create({
        scope: "project",
        project: P1,
        name: "B",
        body: body(),
        pinned: true,
      });
      const other = await service.create({
        scope: "project",
        project: P2,
        name: "C",
        body: body(),
        pinned: true,
      });

      const renamed = await service.update({ promptId: a.promptId, name: "A2" });
      expect(renamed).toMatchObject({ name: "A2", position: 0 });

      const moved = await service.update({ promptId: a.promptId, project: P2 });
      expect(moved).toMatchObject({ project: P2, position: 1 });
      expect((await service.read({ project: P1 })).projectPrompts.map((p) => p.promptId)).toEqual([
        b.promptId,
      ]);
      expect((await service.read({ project: P1 })).projectPrompts[0]?.position).toBe(0);
      expect((await service.read({ project: P2 })).projectPrompts.map((p) => p.promptId)).toEqual([
        other.promptId,
        a.promptId,
      ]);
    });

    it("moves a project prompt to global, appends it, and removes the list gap", async () => {
      const service = createService();
      const first = await service.create({
        scope: "project",
        project: P1,
        name: "A",
        body: body(),
        pinned: true,
      });
      const second = await service.create({
        scope: "project",
        project: P1,
        name: "B",
        body: body(),
        pinned: true,
      });
      await service.update({ promptId: first.promptId, scope: "global", project: null });

      const snapshot = await service.read({ project: P1 });
      expect(snapshot.projectPrompts.map((p) => p.promptId)).toEqual([second.promptId]);
      expect(snapshot.projectPrompts[0]?.position).toBe(0);
      expect(snapshot.globals.map((p) => p.promptId)).toEqual([first.promptId]);
      expect(snapshot.globals[0]?.position).toBe(0);
    });

    it("rejects project on a global prompt and a null project on a project prompt", async () => {
      const service = createService();
      const global = await service.create({
        scope: "global",
        project: null,
        name: "G",
        body: body(),
        pinned: true,
      });
      const project = await service.create({
        scope: "project",
        project: P1,
        name: "P",
        body: body(),
        pinned: true,
      });
      await expect(service.update({ promptId: global.promptId, project: P1 })).rejects.toThrow(
        "quick-prompt.scope-mismatch",
      );
      await expect(service.update({ promptId: project.promptId, project: null })).rejects.toThrow(
        "quick-prompt.scope-mismatch",
      );
    });

    it("drops hidden marks when a global prompt becomes a project prompt", async () => {
      const service = createService();
      const global = await service.create({
        scope: "global",
        project: null,
        name: "G",
        body: body(),
        pinned: true,
      });
      await service.setHidden({ promptId: global.promptId, project: P1, hidden: true });
      await service.update({ promptId: global.promptId, scope: "project", project: P1 });
      const probe = openConnection();
      expect(probe.prepare("SELECT COUNT(*) AS n FROM fork_quick_prompt_hidden").get()?.n).toBe(0);
    });

    it("deletes the prompt and its hidden marks, keeps the list dense, and stays idempotent", async () => {
      const service = createService();
      const first = await service.create({
        scope: "global",
        project: null,
        name: "A",
        body: body(),
        pinned: true,
      });
      const second = await service.create({
        scope: "global",
        project: null,
        name: "B",
        body: body(),
        pinned: true,
      });
      await service.setHidden({ promptId: first.promptId, project: P1, hidden: true });
      afterChange.mockClear();

      await service.delete({ promptId: first.promptId });
      expect(afterChange).toHaveBeenCalledTimes(1);
      const snapshot = await service.read({ project: P1 });
      expect(snapshot.globals.map((p) => [p.promptId, p.position, p.hiddenInProject])).toEqual([
        [second.promptId, 0, false],
      ]);
      const probe = openConnection();
      expect(probe.prepare("SELECT COUNT(*) AS n FROM fork_quick_prompt_hidden").get()?.n).toBe(0);

      afterChange.mockClear();
      await expect(service.delete({ promptId: first.promptId })).resolves.toBeUndefined();
      expect(afterChange).not.toHaveBeenCalled();
    });
  });

  describe("duplicate and pin", () => {
    it("duplicates into another list as an independent pinned copy appended at the end", async () => {
      const service = createService();
      const global = await service.create({
        scope: "global",
        project: null,
        name: "G",
        body: body("x", [paragraph(mention("commands"))]),
        pinned: false,
      });
      const existing = await service.create({
        scope: "project",
        project: P1,
        name: "P",
        body: body(),
        pinned: true,
      });

      const copy = await service.duplicate({
        promptId: global.promptId,
        scope: "project",
        project: P1,
      });
      expect(copy).toMatchObject({
        scope: "project",
        project: P1,
        pinned: true,
        position: 1,
        name: "G",
      });
      expect(copy.promptId).not.toBe(global.promptId);
      expect(copy.body).toEqual(global.body);
      expect((await service.read({ project: P1 })).projectPrompts.map((p) => p.promptId)).toEqual([
        existing.promptId,
        copy.promptId,
      ]);

      await service.update({ promptId: global.promptId, name: "Changed" });
      expect((await service.read({ project: P1 })).projectPrompts[1]?.name).toBe("G");
    });

    it("rejects duplicating a prompt with project-bound mentions into the global list", async () => {
      const service = createService();
      const project = await service.create({
        scope: "project",
        project: P1,
        name: "P",
        body: body("x", [paragraph(mention("files"))]),
        pinned: true,
      });
      await expect(
        service.duplicate({ promptId: project.promptId, scope: "global", project: null }),
      ).rejects.toThrow("quick-prompt.global-mention-blocked");
    });

    it("toggles the pinned flag and reports unknown ids", async () => {
      const service = createService();
      const created = await service.create({
        scope: "project",
        project: P1,
        name: "P",
        body: body(),
        pinned: true,
      });
      await service.setPinned({ promptId: created.promptId, pinned: false });
      expect((await service.read({ project: P1 })).projectPrompts[0]?.pinned).toBe(false);
      await expect(service.setPinned({ promptId: "missing", pinned: true })).rejects.toThrow(
        "quick-prompt.not-found",
      );
    });
  });

  describe("hidden in a project (spec rule 6)", () => {
    it("hides a global only in the chosen project and can unhide it", async () => {
      const service = createService();
      const global = await service.create({
        scope: "global",
        project: null,
        name: "G",
        body: body(),
        pinned: true,
      });

      await service.setHidden({ promptId: global.promptId, project: P1, hidden: true });
      expect((await service.read({ project: P1 })).globals[0]?.hiddenInProject).toBe(true);
      expect((await service.read({ project: P2 })).globals[0]?.hiddenInProject).toBe(false);

      await service.setHidden({ promptId: global.promptId, project: P1, hidden: false });
      expect((await service.read({ project: P1 })).globals[0]?.hiddenInProject).toBe(false);
    });

    it("refuses project prompts and unknown ids", async () => {
      const service = createService();
      const project = await service.create({
        scope: "project",
        project: P1,
        name: "P",
        body: body(),
        pinned: true,
      });
      await expect(
        service.setHidden({ promptId: project.promptId, project: P1, hidden: true }),
      ).rejects.toThrow("quick-prompt.not-global");
      await expect(
        service.setHidden({ promptId: "missing", project: P1, hidden: true }),
      ).rejects.toThrow("quick-prompt.not-found");
    });
  });

  describe("reorder (spec rule 20)", () => {
    it("applies an exact member set and keeps positions dense", async () => {
      const service = createService();
      const a = await service.create({
        scope: "project",
        project: P1,
        name: "A",
        body: body(),
        pinned: true,
      });
      const b = await service.create({
        scope: "project",
        project: P1,
        name: "B",
        body: body(),
        pinned: true,
      });
      const c = await service.create({
        scope: "project",
        project: P1,
        name: "C",
        body: body(),
        pinned: true,
      });

      await service.reorder({
        scope: "project",
        project: P1,
        orderedIds: [c.promptId, a.promptId, b.promptId],
      });

      const snapshot = await service.read({ project: P1 });
      expect(snapshot.projectPrompts.map((p) => [p.promptId, p.position])).toEqual([
        [c.promptId, 0],
        [a.promptId, 1],
        [b.promptId, 2],
      ]);
    });

    it.each([
      ["a missing id", (ids: string[]) => ids.slice(1)],
      ["an extra id", (ids: string[]) => [...ids, "other"]],
      ["a duplicate id", (ids: string[]) => [ids[0]!, ids[0]!, ids[2]!]],
      ["an id from another list", (ids: string[]) => [ids[0]!, ids[1]!, "other"]],
    ])("rejects %s without changing the order", async (_label, change) => {
      const service = createService();
      const a = await service.create({
        scope: "project",
        project: P1,
        name: "A",
        body: body(),
        pinned: true,
      });
      const b = await service.create({
        scope: "project",
        project: P1,
        name: "B",
        body: body(),
        pinned: true,
      });
      const c = await service.create({
        scope: "project",
        project: P1,
        name: "C",
        body: body(),
        pinned: true,
      });
      const before = (await service.read({ project: P1 })).projectPrompts.map((p) => p.promptId);
      afterChange.mockClear();

      await expect(
        service.reorder({
          scope: "project",
          project: P1,
          orderedIds: change([a.promptId, b.promptId, c.promptId]),
        }),
      ).rejects.toThrow("quick-prompt.reorder-mismatch");
      expect((await service.read({ project: P1 })).projectPrompts.map((p) => p.promptId)).toEqual(
        before,
      );
      expect(afterChange).not.toHaveBeenCalled();
    });

    it("reorders globals with null project and never touches project lists", async () => {
      const service = createService();
      const g1 = await service.create({
        scope: "global",
        project: null,
        name: "G1",
        body: body(),
        pinned: true,
      });
      const g2 = await service.create({
        scope: "global",
        project: null,
        name: "G2",
        body: body(),
        pinned: true,
      });
      await service.create({
        scope: "project",
        project: P1,
        name: "P",
        body: body(),
        pinned: true,
      });

      await service.reorder({
        scope: "global",
        project: null,
        orderedIds: [g2.promptId, g1.promptId],
      });
      expect((await service.read({ project: null })).globals.map((p) => p.promptId)).toEqual([
        g2.promptId,
        g1.promptId,
      ]);
    });
  });

  describe("shared truth across Host instances and events", () => {
    it("shows a write made through one connection to a second service on the same file", async () => {
      const writer = createService();
      const reader = createQuickPromptService({
        database: async () => openConnection(),
        afterChange: async () => undefined,
      });
      await writer.create({
        scope: "global",
        project: null,
        name: "G",
        body: body(),
        pinned: true,
      });

      expect((await reader.read({ project: null })).globals).toHaveLength(1);
    });

    it("commits before broadcasting, so a receiver re-reading in the event sees the change", async () => {
      const observed: number[] = [];
      const probe = openConnection();
      const service = createQuickPromptService({
        database: async () => openConnection(),
        afterChange: async () => {
          observed.push(
            Number(probe.prepare("SELECT COUNT(*) AS n FROM fork_quick_prompts").get()?.n),
          );
        },
      });
      await service.create({
        scope: "global",
        project: null,
        name: "G",
        body: body(),
        pinned: true,
      });
      expect(observed).toEqual([1]);
    });

    it("does not broadcast a failed write", async () => {
      const service = createService();
      await expect(
        service.create({ scope: "global", project: P1, name: "G", body: body(), pinned: true }),
      ).rejects.toThrow();
      await expect(service.setPinned({ promptId: "missing", pinned: true })).rejects.toThrow();
      expect(afterChange).not.toHaveBeenCalled();
    });

    it("broadcasts once per committed write", async () => {
      const service = createService();
      const created = await service.create({
        scope: "project",
        project: P1,
        name: "P",
        body: body(),
        pinned: true,
      });
      await service.setPinned({ promptId: created.promptId, pinned: false });
      await service.update({ promptId: created.promptId, name: "Q" });
      expect(afterChange).toHaveBeenCalledTimes(3);
    });
  });
});
