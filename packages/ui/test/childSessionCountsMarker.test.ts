import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readChildSessionExpansionState,
  persistChildSessionsExpanded,
} from "../src/lib/childSessionExpansionPreference.js";

const markerSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/components/ChildSessionCountsMarker.tsx"),
  "utf8",
);
const rowSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/workspace-grouped-tasks/task-row.tsx"),
  "utf8",
);
const childRowsSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/workspace-grouped-tasks/task-child-sessions.tsx"),
  "utf8",
);

describe("child session counts marker (specs/sidebar-child-conversation-counts.md)", () => {
  it("renders per-type glyph segments in the meta-icon family; running reuses the row loading idiom", () => {
    expect(markerSource).toContain("MessageCircle");
    expect(markerSource).toContain("Bot");
    expect(markerSource).toContain("LoaderIcon");
    expect(markerSource).toContain("animate-spin");
    expect(markerSource).toContain("`${running}/${subagentTotal}`");
    // Monochrome meta icons only: no amber/pulse treatment (user decision 2026-10-15).
    expect(markerSource).not.toContain("amber");
    expect(markerSource).not.toContain("pulse");
    expect(markerSource).toContain("size-3.5 shrink-0");
  });

  it("renders in both task-row chains; the drag-overlay chain carries no expander semantics", () => {
    expect(rowSource.match(/<ChildSessionCountsMarker/gu)).toHaveLength(2);
    expect(rowSource).toContain("<ChildSessionCountsMarker task={task} expanded={false} />");
    expect(rowSource).toContain("onToggle={handleToggleChildSessions}");
    // The marker click must not select the task row underneath it.
    expect(markerSource).toContain("stopPropagation");
  });

  it("keeps the interactive marker outside the hover-suppressed metadata span (expander stays clickable)", () => {
    // Hover/focus suppress the metadata span (shouldSuppressTaskMetadata) and mount hover actions
    // in its place; an expander inside that span would unmount on mouseenter before the click
    // lands. The marker must sit between the metadata span and the hover-action cluster.
    const markerIdx = rowSource.indexOf("onToggle={handleToggleChildSessions}");
    const interactiveTimeIdx = rowSource.lastIndexOf("{taskTimeLabel}</span>");
    const hoverActionsIdx = rowSource.indexOf("{shouldMountHoverActions ? (");
    expect(markerIdx).toBeGreaterThan(interactiveTimeIdx);
    expect(markerIdx).toBeLessThan(hoverActionsIdx);
  });

  it("child rows reuse the group nesting rail, stop row propagation, and open sessions via onSelectTask", () => {
    expect(childRowsSource).toContain("ml-4 border-l border-border py-px pl-2");
    expect(childRowsSource).toContain(
      "onSelectTask(task.workspacePath, sessionId, task.workspaceIdentity, undefined, undefined,",
    );
    expect(childRowsSource).toContain(
      'openSession(child.sessionId, child.taskType === "subagent_child")',
    );
    // True totals minus the capped list drive the overflow row.
    expect(childRowsSource).toContain("taskList.childMoreLabel");
    expect(childRowsSource).toContain("overflow");
  });
});

describe("child session expansion preference", () => {
  it("stores only explicitly expanded parents; default collapsed", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    };
    expect(readChildSessionExpansionState(storage)).toEqual({});
    persistChildSessionsExpanded("s-parent", true, storage);
    expect(readChildSessionExpansionState(storage)).toEqual({ "s-parent": true });
    persistChildSessionsExpanded("s-other", true, storage);
    expect(readChildSessionExpansionState(storage)).toEqual({
      "s-parent": true,
      "s-other": true,
    });
    persistChildSessionsExpanded("s-parent", false, storage);
    expect(readChildSessionExpansionState(storage)).toEqual({ "s-other": true });
  });

  it("tolerates corrupt stored payloads", () => {
    const backing = new Map<string, string>([["zcode-child-session-expansion", "not-json"]]);
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    };
    expect(readChildSessionExpansionState(storage)).toEqual({});
  });
});
