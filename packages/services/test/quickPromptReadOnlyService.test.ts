import { describe, expect, it, vi } from "vitest";
import {
  createReadOnlyQuickPromptService,
  QUICK_PROMPT_READ_ONLY_ERROR,
  type IQuickPromptService,
} from "../src/quick-prompts/index.js";

// Spec: specs/composer-quick-prompts.md (rule 21, acceptance scenario 10). Mobile attachments read the controller's
// quick prompts; every mutation must reject with the stable code, whichever transport exposes the service.

function fakeService(): { [K in keyof IQuickPromptService]: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn(async () => ({ project: null, globals: [], projectPrompts: [] })),
    readProjects: vi.fn(async () => []),
    create: vi.fn(async () => {
      throw new Error("inner create must not run");
    }),
    update: vi.fn(async () => {
      throw new Error("inner update must not run");
    }),
    delete: vi.fn(async () => undefined),
    duplicate: vi.fn(async () => {
      throw new Error("inner duplicate must not run");
    }),
    setPinned: vi.fn(async () => undefined),
    setHidden: vi.fn(async () => undefined),
    reorder: vi.fn(async () => undefined),
  };
}

describe("createReadOnlyQuickPromptService", () => {
  it("keeps read and readProjects delegating to the source service", async () => {
    const source = fakeService();
    const service = createReadOnlyQuickPromptService(source as unknown as IQuickPromptService);
    const input = { project: { hostId: "local", projectId: "project:one" } };

    await expect(service.read(input)).resolves.toEqual({
      project: null,
      globals: [],
      projectPrompts: [],
    });
    expect(source.read).toHaveBeenCalledWith(input);
    await expect(service.readProjects()).resolves.toEqual([]);
    expect(source.readProjects).toHaveBeenCalledTimes(1);
  });

  it("rejects every mutation with quick-prompt.read-only without reaching the source", async () => {
    const source = fakeService();
    const service = createReadOnlyQuickPromptService(source as unknown as IQuickPromptService);
    const project = { hostId: "local", projectId: "project:one" };
    const mutations: Array<() => Promise<unknown>> = [
      () =>
        service.create({
          scope: "global",
          project: null,
          name: "x",
          body: { markdown: "x", nodes: "[]" },
          pinned: true,
        }),
      () => service.update({ promptId: "p1", name: "renamed" }),
      () => service.delete({ promptId: "p1" }),
      () => service.duplicate({ promptId: "p1", scope: "global", project: null }),
      () => service.setPinned({ promptId: "p1", pinned: false }),
      () => service.setHidden({ promptId: "p1", project, hidden: true }),
      () => service.reorder({ scope: "global", project: null, orderedIds: [] }),
    ];

    for (const mutation of mutations) {
      await expect(mutation()).rejects.toThrow(QUICK_PROMPT_READ_ONLY_ERROR);
    }
    expect(QUICK_PROMPT_READ_ONLY_ERROR).toBe("quick-prompt.read-only");
    for (const key of [
      "create",
      "update",
      "delete",
      "duplicate",
      "setPinned",
      "setHidden",
      "reorder",
    ] as const) {
      expect(source[key]).not.toHaveBeenCalled();
    }
  });
});
