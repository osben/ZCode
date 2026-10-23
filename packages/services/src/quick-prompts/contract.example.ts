/**
 * quick-prompts: the usual round trip a renderer makes (read for the session's project, then a write; the
 * service broadcasts QUICK_PROMPTS_CHANGED_CHANNEL and every renderer reads again).
 */
import type { IQuickPromptService, QuickPromptProjectRef } from "./contract.js";

export async function exampleQuickPrompts(service: IQuickPromptService): Promise<void> {
  const project: QuickPromptProjectRef = { hostId: "local", projectId: "project-1" };
  const snapshot = await service.read({ project });
  const created = await service.create({
    scope: "project",
    project,
    name: "Run e2e",
    body: {
      markdown: "Run pnpm test:e2e and summarize failures.",
      nodes: JSON.stringify([
        {
          type: "paragraph",
          version: 1,
          children: [
            { type: "text", text: "Run pnpm test:e2e and summarize failures.", version: 1 },
          ],
        },
      ]),
    },
    pinned: true,
  });
  const firstGlobal = snapshot.globals[0];
  if (firstGlobal) {
    await service.setHidden({ promptId: firstGlobal.promptId, project, hidden: true });
  }
  await service.reorder({
    scope: "project",
    project,
    orderedIds: [created.promptId, ...snapshot.projectPrompts.map((prompt) => prompt.promptId)],
  });
}
