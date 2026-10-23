// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuickPromptProjectRef, QuickPromptSnapshot } from "@zcode/services";

const fake = vi.hoisted(() => ({
  services: null as null | Record<string, unknown>,
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => fake.services,
}));

import { useQuickPrompts } from "@/quick-prompts/useQuickPrompts.js";

type Listener = (event: { channel: string }) => void;

function snapshotNamed(
  project: QuickPromptProjectRef | null,
  names: string[],
): QuickPromptSnapshot {
  return {
    project,
    globals: names.map((name, index) => ({
      promptId: `g${index}`,
      scope: "global",
      project: null,
      name,
      body: { markdown: name, nodes: "[]" },
      pinned: true,
      position: index,
      createdAt: 1,
      updatedAt: 1,
      hiddenInProject: false,
    })),
    projectPrompts: [],
  };
}

function Probe({ project }: { project: QuickPromptProjectRef | null }) {
  const state = useQuickPrompts(project);
  return createElement(
    "div",
    { "data-testid": "probe" },
    state.snapshot ? state.snapshot.globals.map((item) => item.name).join(",") : "none",
  );
}

function setup() {
  const listeners = new Set<Listener>();
  const read =
    vi.fn<(input: { project: QuickPromptProjectRef | null }) => Promise<QuickPromptSnapshot>>();
  fake.services = {
    quickPromptService: { read },
    broadcastService: {
      onMessage: (listener: Listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
  };
  return {
    read,
    emit: (channel: string) => act(() => listeners.forEach((listener) => listener({ channel }))),
  };
}

afterEach(() => {
  cleanup();
  fake.services = null;
});

describe("useQuickPrompts", () => {
  it("re-reads when the quick prompts broadcast arrives", async () => {
    const { read, emit } = setup();
    read.mockResolvedValueOnce(snapshotNamed(null, ["a"]));
    render(createElement(Probe, { project: null }));
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("a"));

    read.mockResolvedValueOnce(snapshotNamed(null, ["a", "b"]));
    emit("state:task-groups");
    expect(read).toHaveBeenCalledTimes(1);
    emit("state:quick-prompts");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("a,b"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never shows a previous project's snapshot and drops its late response", async () => {
    const { read } = setup();
    const first: QuickPromptProjectRef = { hostId: "h", projectId: "p1" };
    const second: QuickPromptProjectRef = { hostId: "h", projectId: "p2" };
    let resolveFirst!: (value: QuickPromptSnapshot) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    read.mockResolvedValueOnce(snapshotNamed(second, ["second"]));

    const view = render(createElement(Probe, { project: first }));
    view.rerender(createElement(Probe, { project: second }));
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("second"));

    await act(async () => resolveFirst(snapshotNamed(first, ["stale"])));
    expect(screen.getByTestId("probe").textContent).toBe("second");
  });

  it("shows nothing when no quick prompt service is wired", () => {
    setup();
    fake.services = { broadcastService: { onMessage: () => ({ dispose: () => undefined }) } };
    render(createElement(Probe, { project: null }));
    expect(screen.getByTestId("probe").textContent).toBe("none");
  });
});
