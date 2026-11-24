import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const settingsLayerProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

const passThrough = ({ children }: { children?: ReactNode }) => children ?? null;
vi.mock("@/App.js", () => ({ App: () => null }));
vi.mock("@/project-sidebar/index.js", () => ({ ProjectDirectoryProvider: passThrough }));
vi.mock("@/ErrorBoundary.js", () => ({ ScopedErrorBoundary: passThrough }));
vi.mock("@/hooks/useServices.js", () => ({ ServiceProvider: passThrough }));
vi.mock("@/v4/telemetry/ConversationTelemetryAttachment.js", () => ({
  ConversationTelemetryWorkspaceAttachment: passThrough,
}));
vi.mock("@/root/WorkspaceSettingsLayer.js", () => ({
  WorkspaceSettingsLayer: (props: Record<string, unknown>) => {
    settingsLayerProps.push(props);
    return null;
  },
}));

const { RootWorkspaceContent } = await import("@/root/RootWorkspaceContent.js");

function render(webRemoteControlWorkspaceSwitcher: unknown) {
  renderToStaticMarkup(
    createElement(RootWorkspaceContent, {
      isSettingsTabActive: true,
      workspaceShellPath: "/project",
      activeWorkspacePath: "/project",
      webRemoteControlWorkspaceSwitcher,
    } as unknown as Parameters<typeof RootWorkspaceContent>[0]),
  );
  return settingsLayerProps.at(-1);
}

beforeEach(() => {
  settingsLayerProps.length = 0;
});

// specs/session-deletion-cascade.md: Web remote control disables permanent Delete in Settings.
it("marks the workspace settings layer as Web remote control on the phone", () => {
  expect(render({ openWorkspace: () => undefined })?.isWebRemoteControl).toBe(true);
});

it("keeps the workspace settings layer local on the desktop", () => {
  expect(render(undefined)?.isWebRemoteControl).toBe(false);
});
