// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceServerManagementSnapshot } from "@zcode/shared";

import { TEST_LOCALE } from "./helpers/uiCopy.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: TEST_LOCALE,
  }),
}));

import { RemoteConnectionSelection } from "@/remote-connection/RemoteConnectionSelection.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const preferredProfileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const historyProfileId = "28ef20b3-622d-4a53-98c1-0cdff29f3e6d";

function snapshotOf(online: boolean): SourceServerManagementSnapshot {
  return {
    generation: 1,
    profiles: [
      {
        profileId: preferredProfileId,
        transport: "ssh",
        target: { kind: "ssh", host: "10.0.0.4", username: "dev" },
        sourceServerId,
        createdAt: 1,
        lifecycleState: "active",
      },
      {
        profileId: historyProfileId,
        transport: "ssh",
        target: { kind: "ssh", host: "10.0.0.5", username: "dev" },
        sourceServerId,
        createdAt: 2,
        lifecycleState: "active",
      },
    ],
    servers: [
      {
        sourceServerId,
        displayName: "devbox",
        installState: "installed",
        preferredProfileId,
      },
    ],
    workspaceHistory: [
      {
        workspacePath: "/home/dev",
        profileId: preferredProfileId,
        sourceServerId,
        lastOpenedAt: 1,
      },
      {
        workspacePath: "/home/dev/test",
        profileId: historyProfileId,
        sourceServerId,
        lastOpenedAt: 2,
      },
    ],
    states: online
      ? [
          {
            profileId: preferredProfileId,
            sourceServerId,
            state: "online",
            updateAvailability: "none",
            updatedAt: 1,
          },
        ]
      : [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  } as never;
}

function renderDeviceStep(snapshot: SourceServerManagementSnapshot) {
  const onSelectProfile = vi.fn();
  render(
    createElement(RemoteConnectionSelection, {
      snapshot,
      onSelectProfile,
      onNewConnection: vi.fn(),
      aliases: [],
      distros: [],
      containers: [],
      availableKinds: ["ssh"],
      dockerAvailable: null,
      loading: false,
      discoveryError: "",
      onSelectAlias: vi.fn(),
      onSelectTarget: vi.fn(),
      remoteConversationWorkspaceBySourceServerId: {},
    }),
  );
  return onSelectProfile;
}

/**
 * Device-card "recent directory" interaction contract
 * (docs/design/r3-remote-ui-redesign.md first screen: one-click open of recent directories):
 * clicking a directory row opens the workspace directly along the line that directory belongs to;
 * "choose another directory" only enters the directory browser.
 * The two are decoupled, and a directory row is no longer a "selected" state needing confirmation.
 */
describe("RemoteConnectionDeviceStep recent workspace entries", () => {
  it("opens the workspace immediately when a recent directory row is clicked", () => {
    const onSelectProfile = renderDeviceStep(snapshotOf(true));

    fireEvent.click(screen.getByText("/home/dev/test"));

    expect(onSelectProfile).toHaveBeenCalledTimes(1);
    expect(onSelectProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: historyProfileId }),
      "/home/dev/test",
    );
  });

  it("always opens the directory browser from the choose-directory button", () => {
    const onSelectProfile = renderDeviceStep(snapshotOf(true));

    // A directory row was clicked first, then "choose another directory": the button must not
    // inherit any "selected directory" and must enter the directory browser.
    fireEvent.click(screen.getByText("/home/dev"));
    fireEvent.click(screen.getByText("devbox"));

    expect(onSelectProfile).toHaveBeenCalledTimes(2);
    expect(onSelectProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId: preferredProfileId }),
    );
  });

  it("connects and opens recent directories while the device is offline", () => {
    const onSelectProfile = renderDeviceStep(snapshotOf(false));

    const row = screen.getByText("/home/dev/test").closest("button");
    expect(row?.disabled).toBe(false);
    fireEvent.click(row!);
    expect(onSelectProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: historyProfileId }),
      "/home/dev/test",
    );
  });
});
