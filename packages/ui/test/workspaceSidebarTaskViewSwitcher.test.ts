import { describe, expect, it } from "vitest";
import { resolveSidebarTaskGroupTogglePresentation } from "@/WorkspaceSidebar/taskGroupTogglePresentation.js";

describe("WorkspaceSidebar task view switcher", () => {
  it("keeps the previous expand-all button presentation while the next task view hydrates", () => {
    const previousPresentation = {
      canToggle: true,
      areAllExpanded: true,
      messageId: "workspaceSidebar.collapseAllGroups" as const,
    };

    const presentation = resolveSidebarTaskGroupTogglePresentation({
      previous: previousPresentation,
      current: {
        visible: true,
        canToggle: false,
        areAllExpanded: false,
        transitionPending: true,
      },
    });

    expect(presentation).toEqual(previousPresentation);
  });

  it("uses the current expand-all button presentation after the task view hydrates", () => {
    const presentation = resolveSidebarTaskGroupTogglePresentation({
      previous: {
        canToggle: true,
        areAllExpanded: true,
        messageId: "workspaceSidebar.collapseAllGroups",
      },
      current: {
        visible: true,
        canToggle: false,
        areAllExpanded: false,
        transitionPending: false,
      },
    });

    expect(presentation).toEqual({
      canToggle: false,
      areAllExpanded: false,
      messageId: "workspaceSidebar.expandAllGroups",
    });
  });
});
