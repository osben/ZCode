// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type {
  SourceServerConnectionStateSnapshot,
  SourceServerManagementSnapshot,
} from "@zcode/shared";
import {
  getProjectCount,
  SourceServerManagementPanel,
} from "@/settings/SourceServerManagementPanel.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, number | string>) =>
        values?.projects
          ? `${id}:${values.projects}`
          : values?.attempt !== undefined
            ? `${id}:${values.attempt}/${values.limit}`
            : id,
    },
  }),
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", () => ({ toast: showToast }));
const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => confirmDialog }));
beforeEach(() => confirmDialog.mockReset().mockResolvedValue(true));
const platform = vi.hoisted(() => ({
  listSSHConfigAliases: vi.fn(async () => []),
  selectFile: vi.fn(),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => platform,
  useOptionalPlatform: () => platform,
}));

function identityPendingSnapshot(
  installState: "installed" | "uninstalled",
  pendingProfileId: string,
): SourceServerManagementSnapshot {
  const profileIds =
    pendingProfileId === "preferred" ? ["preferred"] : ["preferred", pendingProfileId];
  return {
    generation: 1,
    profiles: profileIds.map((profileId) => ({
      profileId,
      sourceServerId: "old-source",
      transport: "ssh",
      target: { kind: "ssh", host: `${profileId}.example.com`, username: "dev" },
      createdAt: 1,
      lifecycleState: "active",
    })),
    servers: [
      {
        sourceServerId: "old-source",
        displayName: "Reinstalled server",
        preferredProfileId: "preferred",
        installState,
        declaredWorkspaces: [],
      },
    ],
    workspaceHistory: [],
    states: profileIds.map((profileId) => ({
      profileId,
      sourceServerId: "old-source",
      state: profileId === pendingProfileId ? "identity-change-pending" : "offline",
      ...(profileId === pendingProfileId ? { pendingSourceServerId: "new-source" } : {}),
      updatedAt: 1,
    })),
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SourceServerManagementPanel", () => {
  it("the current connection sits on the second line with the default connection under other connections; recent projects sort by open time and expand to all", async () => {
    const snapshot = identityPendingSnapshot("installed", "other");
    snapshot.states[0]!.state = "offline";
    snapshot.states[1]!.state = "online";
    snapshot.workspaceHistory = (
      [
        ["alpha", 1],
        ["beta", 4],
        ["gamma", 3],
        ["delta", 2],
      ] as const
    ).map(([name, lastOpenedAt]) => ({
      sourceServerId: "old-source",
      profileId: "other",
      workspacePath: `/work/${name}`,
      workspaceIdentity: `remote:${name}`,
      lastOpenedAt,
    }));
    const open = vi.fn(async () => {});
    const setPreferredProfile = vi.fn(async () => snapshot);
    const { container } = render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
          setPreferredProfile,
        } as never,
        onOpenProject: open,
        workspaceTabs: [
          {
            id: "beta-tab",
            kind: "workspace",
            label: "beta",
            workspacePath: "/work/beta",
            workspaceIdentity: "remote:server:old-source:/work/beta",
          },
        ],
      }),
    );
    await screen.findByText("Reinstalled server");
    const line = container.querySelector("[data-device-connection]")!;
    expect(line.textContent).toContain("other.example.com");
    expect(line.textContent).toContain("settings.source.currentProfile");
    expect(line.textContent).not.toContain("settings.source.defaultProfile");
    fireEvent.click(screen.getByRole("button", { name: "settings.source.setDefault" }));
    await waitFor(() => expect(setPreferredProfile).toHaveBeenCalledWith("old-source", "other"));
    const projectNames = () =>
      [...container.querySelectorAll("[data-device-project]")].map((row) =>
        row.getAttribute("aria-label"),
      );
    // Most recently opened first, only three rows shown by default; the
    // unclickable +N must not reappear.
    expect(projectNames()).toEqual(["beta", "gamma", "delta"]);
    expect(screen.queryByText("+1")).toBeNull();
    const betaRow = container.querySelector('[data-device-project][aria-label="beta"]')!;
    expect(betaRow.textContent).toContain("/work/beta");
    expect(betaRow.textContent).toContain("settings.source.projectOpened");
    expect(
      container.querySelector('[data-device-project][aria-label="gamma"]')!.textContent,
    ).not.toContain("settings.source.projectOpened");
    fireEvent.click(screen.getByRole("button", { name: "settings.source.showAllProjects" }));
    expect(projectNames()).toEqual(["beta", "gamma", "delta", "alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("old-source", "/work/alpha", "other"));
    fireEvent.click(screen.getByRole("button", { name: "settings.source.showLessProjects" }));
    expect(projectNames()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "settings.source.otherSavedConnections" }));
    expect(screen.getByText("dev@preferred.example.com:22")).toBeTruthy();
    expect(screen.getByText("settings.source.defaultProfile")).toBeTruthy();
  });

  it("a single connection shows no current/default badges and the line shows the remote version", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0]!.state = "online";
    snapshot.servers[0]!.lastSeenVersion = "v1.4.2";
    const { container } = render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );
    await screen.findByText("Reinstalled server");
    const line = container.querySelector("[data-device-connection]")!;
    expect(line.textContent).toContain("dev@preferred.example.com:22");
    expect(line.textContent).toContain("1.4.2");
    expect(line.textContent).not.toContain("settings.source.currentProfile");
    expect(line.textContent).not.toContain("settings.source.defaultProfile");
    expect(container.querySelector("[data-device-projects]")?.textContent).toContain(
      "settings.source.projectCount",
    );
  });

  it("an optional update deferred with Later stays hidden across panel remounts and reconnects; a new version shows again", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      ...snapshot.states[0]!,
      state: "online",
      updateAvailability: "available",
      availableVersion: "defer-test-1",
      upgradeTarget: "server",
    };
    const management = {
      getSnapshot: async () => snapshot,
      onDidChangeState: new Emitter().event,
    } as never;
    const first = render(createElement(SourceServerManagementPanel, { management }));
    fireEvent.click(await screen.findByRole("button", { name: "updateDialog.later" }));
    expect(screen.queryByText("settings.source.updateAvailableVersion")).toBeNull();
    first.unmount();
    const second = render(createElement(SourceServerManagementPanel, { management }));
    await screen.findByText("Reinstalled server");
    expect(screen.queryByText("settings.source.updateAvailableVersion")).toBeNull();
    second.unmount();
    snapshot.states[0]!.availableVersion = "defer-test-2";
    render(createElement(SourceServerManagementPanel, { management }));
    expect(await screen.findByRole("button", { name: "updateDialog.later" })).toBeTruthy();
  });

  it("the forced-update confirmation lists running tasks returned by the Host; cancelling does not send force=true", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      ...snapshot.states[0]!,
      state: "needs-upgrade",
      updateAvailability: "required",
      upgradeTarget: "server",
      runningTasks: [{ sessionId: "running-session", workspacePath: "/work/alpha" }],
    };
    const updateSource = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("busy"), { code: "source-server-update-running-tasks" }),
      );
    confirmDialog.mockResolvedValue(false);
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
          updateSource,
        } as never,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "remote.action.update-server" }));
    await waitFor(() =>
      expect(confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining("running-session — /work/alpha"),
        }),
      ),
    );
    expect(updateSource.mock.calls).toEqual([[{ profileId: "preferred", force: false }]]);
  });

  it("an update failing after leaving settings shows a toast whose details reopen the device via stable navigation", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      ...snapshot.states[0]!,
      state: "needs-upgrade",
      updateAvailability: "required",
      upgradeTarget: "server",
    };
    const pending = Promise.withResolvers<SourceServerManagementSnapshot>();
    const updateSource = vi.fn(() => pending.promise);
    const onShowUpdateDetails = vi.fn();
    const view = render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
          updateSource,
        } as never,
        onShowUpdateDetails,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "remote.action.update-server" }));
    await waitFor(() => expect(updateSource).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => pending.reject(new Error("update failed")));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "sourceServer.updateFailedToast",
        expect.objectContaining({ actionLabel: "remote.action.details" }),
      ),
    );
    showToast.mock.calls.at(-1)![1].onAction();
    expect(onShowUpdateDetails).toHaveBeenCalledWith("old-source");
  });

  it("unfinished connections expose recent logs when expanded; cleanup skips the just-recognized device", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.servers = [];
    snapshot.profiles[0]!.profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
    delete snapshot.profiles[0]!.sourceServerId;
    snapshot.states[0] = {
      profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
      state: "failed",
      updatedAt: 1,
      errorCode: "remote-host-unreachable",
    };
    let current = snapshot;
    const removeProfile = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => current,
          onDidChangeState: new Emitter().event,
          removeProfile,
          getRecentOperationLogs: async () => [
            {
              timestamp: 1,
              level: "error",
              phase: "connect",
              operation: "connect",
              message: "Connection refused",
              profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
            },
          ],
        } as never,
      }),
    );
    fireEvent.click(await screen.findByText("settings.source.unfinishedConnections"));
    fireEvent.click(await screen.findByRole("button", { name: "settings.source.recentLog" }));
    expect(await screen.findByText("Connection refused")).toBeTruthy();
    current = identityPendingSnapshot("installed", "preferred");
    fireEvent.click(screen.getByRole("button", { name: "settings.source.clearUnfinished" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(removeProfile).not.toHaveBeenCalled();
  });

  it("updating overrides the stale error retained on the connection record", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0]!.state = "updating";
    snapshot.profiles[0]!.lastConnectError = "OLD_INSTALL_FAILURE";
    const emitter = new Emitter();
    render(
      createElement(SourceServerManagementPanel, {
        management: { getSnapshot: async () => snapshot, onDidChangeState: emitter.event } as never,
      }),
    );
    expect(await screen.findByText("remote.status.updating")).toBeTruthy();
    expect(screen.queryByText("settings.source.lastConnectError")).toBeNull();
  });

  it("the device card repairs the connection that errored, not the offline preferred connection", async () => {
    const snapshot = identityPendingSnapshot("installed", "other");
    snapshot.states[1] = {
      profileId: "other",
      sourceServerId: "old-source",
      state: "failed",
      error: "host not found",
      errorCode: "remote-host-not-found",
      updatedAt: 2,
    };
    const emitter = new Emitter();
    const management = {
      getSnapshot: async () => snapshot,
      onDidChangeState: emitter.event,
    } as never;
    render(createElement(SourceServerManagementPanel, { management, onConnectProfile: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "remote.action.edit-host" }));
    expect((screen.getByLabelText("ssh.host") as HTMLInputElement).value).toBe("other.example.com");
  });

  it.each(["remote-permission-denied", "remote-host-not-found"] as const)(
    "%s primary action opens details or edits the host instead of blindly reconnecting",
    async (errorCode) => {
      const snapshot = identityPendingSnapshot("installed", "preferred");
      snapshot.states[0] = {
        profileId: "preferred",
        sourceServerId: "old-source",
        state: "failed",
        error: "diagnostic details",
        errorCode,
        updatedAt: 2,
      };
      const emitter = new Emitter();
      const management = {
        getSnapshot: async () => snapshot,
        onDidChangeState: emitter.event,
      } as never;
      const onConnectProfile = vi.fn();
      render(createElement(SourceServerManagementPanel, { management, onConnectProfile }));
      fireEvent.click(
        await screen.findByRole("button", {
          name:
            errorCode === "remote-permission-denied"
              ? "remote.action.details"
              : "remote.action.edit-host",
        }),
      );
      expect(await screen.findByRole("dialog")).toBeTruthy();
      expect(onConnectProfile).not.toHaveBeenCalled();
      if (errorCode === "remote-host-not-found")
        expect(screen.getByLabelText("ssh.host").getAttribute("aria-invalid")).toBe("true");
      else
        expect(screen.getByRole("dialog").textContent).toContain(
          "remote.error.permissionDenied.reason",
        );
    },
  );

  it("when the local app is too old it shows update desktop while the connection config still opens", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      profileId: "preferred",
      sourceServerId: "old-source",
      state: "needs-upgrade",
      updateAvailability: "required",
      upgradeTarget: "controller",
      updatedAt: 2,
    };
    const stateEmitter = new Emitter();
    const management = {
      getSnapshot: async () => snapshot,
      onDidChangeState: stateEmitter.event,
    } as never;
    const onConnectProfile = vi.fn();
    render(createElement(SourceServerManagementPanel, { management, onConnectProfile }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "remote.action.update-desktop" }).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByText("remote.status.needsUpdate")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "remote.action.connect" }));
    expect(onConnectProfile).toHaveBeenCalledWith("preferred");
    expect(screen.queryByRole("button", { name: "remote.action.update-server" })).toBeNull();
  });

  it("the fallback connection next to the update-desktop hint also guards against double submits and catches async failures", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      profileId: "preferred",
      sourceServerId: "old-source",
      state: "needs-upgrade",
      updateAvailability: "required",
      upgradeTarget: "controller",
      updatedAt: 2,
    };
    let reject!: (error: Error) => void;
    const connect = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
        onConnectProfile: connect,
      }),
    );
    const button = await screen.findByRole("button", { name: "remote.action.connect" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(connect).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => reject(new Error("connection failed")));
    expect(screen.getByRole("alert").textContent).toContain("settings.source.operationFailed");
  });

  it("closing and reopening settings still queries the device's last failure log", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0]!.state = "failed";
    const stateEmitter = new Emitter();
    const getRecentOperationLogs = vi.fn(async () => [
      {
        profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
        operation: "connect",
        phase: "probe",
        level: "error",
        message: "Connection refused",
        timestamp: 10,
      },
    ]);
    const management = {
      getSnapshot: async () => snapshot,
      getRecentOperationLogs,
      onDidChangeState: stateEmitter.event,
    } as never;
    // A failed device's recent log expands by default; after the user collapses
    // it, the user's choice wins.
    const first = render(createElement(SourceServerManagementPanel, { management }));
    await waitFor(() => expect(screen.getByText("Connection refused")).toBeTruthy());
    fireEvent.click(screen.getByText("settings.source.recentLog"));
    expect(screen.queryByText("Connection refused")).toBeNull();
    first.unmount();
    render(createElement(SourceServerManagementPanel, { management }));
    await waitFor(() => expect(screen.getByText("Connection refused")).toBeTruthy());
    expect(getRecentOperationLogs).toHaveBeenCalledWith("preferred");
  });

  it.each([
    ["installed", "preferred"],
    ["uninstalled", "preferred"],
    ["installed", "alternative"],
    ["uninstalled", "alternative"],
  ] as const)(
    "identity-change confirmation for the %s route of a %s device is always reachable; cancel has no side effects and confirm uses the original service",
    async (installState, pendingProfileId) => {
      const snapshot = identityPendingSnapshot(installState, pendingProfileId);
      let complete!: (value: SourceServerManagementSnapshot) => void;
      const confirmIdentityChange = vi.fn(
        () =>
          new Promise<SourceServerManagementSnapshot>((resolve) => {
            complete = resolve;
          }),
      );
      const onCreateConnection = vi.fn();
      const onConnectProfile = vi.fn();
      render(
        createElement(SourceServerManagementPanel, {
          management: {
            getSnapshot: vi.fn(async () => snapshot),
            onDidChangeState: new Emitter().event,
            confirmIdentityChange,
          } as never,
          onCreateConnection,
          onConnectProfile,
        }),
      );
      const button = await screen.findByRole("button", {
        name: "settings.source.identityChangeConfirm",
      });
      expect(confirmIdentityChange).not.toHaveBeenCalled();
      confirmDialog.mockResolvedValueOnce(false);
      fireEvent.click(button);
      await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
      expect(confirmIdentityChange).not.toHaveBeenCalled();
      fireEvent.click(button);
      await waitFor(() =>
        expect(confirmIdentityChange).toHaveBeenCalledExactlyOnceWith(pendingProfileId),
      );
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(onCreateConnection).not.toHaveBeenCalled();
      expect(onConnectProfile).not.toHaveBeenCalled();
      await act(async () => complete({ ...snapshot, generation: 2, states: [] }));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "settings.source.identityChangeConfirm" }),
        ).toBeNull(),
      );
    },
  );

  it("multiple pending identity-change routes on an uninstalled device are individually actionable without expanding; the preferred route comes first", async () => {
    const snapshot = identityPendingSnapshot("uninstalled", "alternative");
    snapshot.states = snapshot.states.map((state) => ({
      ...state,
      state: "identity-change-pending",
      pendingSourceServerId: "new-source",
    }));
    const confirmIdentityChange = vi.fn(async () => snapshot);
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          confirmIdentityChange,
        } as never,
      }),
    );
    await screen.findByText("Reinstalled server");
    const buttons = screen.getAllByRole("button", {
      name: "settings.source.identityChangeConfirm",
    });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(confirmIdentityChange).toHaveBeenCalledWith("preferred"));
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(confirmIdentityChange).toHaveBeenLastCalledWith("alternative"));
  });

  it("identity confirmation failure shows an error and keeps the entry; no auto-retry or faked recovery", async () => {
    const snapshot = identityPendingSnapshot("uninstalled", "preferred");
    const confirmIdentityChange = vi.fn(async () => {
      throw new Error("connection lost");
    });
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          confirmIdentityChange,
        } as never,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "settings.source.identityChangeConfirm" }),
    );
    expect(await screen.findByText("settings.source.operationFailed")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "settings.source.identityChangeConfirm" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(confirmIdentityChange).toHaveBeenCalledExactlyOnceWith("preferred");
  });

  it("only exposes startup reconnect as a global connection preference", async () => {
    const onUpdateSettings = vi.fn(async () => undefined);
    const snapshot: SourceServerManagementSnapshot = {
      generation: 0,
      profiles: [],
      servers: [],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };

    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
        } as never,
        settings: { remoteStartupAutoReconnectEnabled: false },
        onUpdateSettings,
      }),
    );

    expect(await screen.findByText("settings.source.connectionPreferences")).toBeTruthy();

    const toggle = screen.getByRole("switch", {
      name: "settings.source.startupAutoReconnect",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(onUpdateSettings).toHaveBeenCalledWith({
        remoteStartupAutoReconnectEnabled: true,
      }),
    );
  });

  it("only the loading state before loading completes; the empty state after completion allows creating a connection", async () => {
    let complete!: (snapshot: SourceServerManagementSnapshot) => void;
    const create = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: () =>
            new Promise<SourceServerManagementSnapshot>((resolve) => {
              complete = resolve;
            }),
          onDidChangeState: new Emitter().event,
        } as never,
        onCreateConnection: create,
      }),
    );
    expect(screen.getByRole("status").textContent).toContain("common.loading");
    expect(screen.queryByText("settings.source.empty")).toBeNull();
    const empty = identityPendingSnapshot("installed", "preferred");
    await act(async () => complete({ ...empty, servers: [], profiles: [], states: [] }));
    expect(screen.getByText("settings.source.empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "settings.source.newConnection" }));
    expect(create).toHaveBeenCalledOnce();
  });

  it("the switch blocks duplicate submits while saving, rolls back and toasts on failure", async () => {
    let reject!: (cause: Error) => void;
    const save = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => identityPendingSnapshot("installed", "preferred"),
          onDidChangeState: new Emitter().event,
        } as never,
        settings: { remoteStartupAutoReconnectEnabled: true },
        onUpdateSettings: save,
      }),
    );
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("disk full")));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("settings.source.operationFailed");
  });

  it("disconnect needs no confirmation and shows the tasks-continue hint; a second disconnect is rejected while pending", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0]!.state = "online";
    let complete!: () => void;
    const disconnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
        onDisconnectSource: disconnect,
      }),
    );
    const button = await screen.findByRole("button", { name: "remote.action.disconnect" });
    // The tasks-continue hint lives on the disconnect button only, no longer
    // occupying a standing line.
    expect(button.getAttribute("title")).toBe("settings.source.disconnectHint");
    expect(screen.queryByText("settings.source.disconnectHint")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("old-source");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(confirmDialog).not.toHaveBeenCalled();
    await act(async () => complete());
  });

  it("removing a device lists only that Source's open projects; the locate callback carries the Source identity", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0]!.state = "offline";
    const reveal = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
        onShowInSidebar: reveal,
        workspaceTabs: [
          {
            id: "a",
            kind: "workspace",
            label: "Project A",
            workspacePath: "/same-path",
            workspaceIdentity: "remote:server:old-source:/same-path",
          },
          {
            id: "b",
            kind: "workspace",
            label: "Project B",
            workspacePath: "/same-path",
            workspaceIdentity: "remote:server:other-source:/same-path",
          },
        ],
      }),
    );
    await screen.findByText("Reinstalled server");
    fireEvent.pointerDown(screen.getByRole("button", { name: "common.more" }));
    fireEvent.click(await screen.findByText("settings.source.showInSidebar"));
    expect(reveal).toHaveBeenCalledExactlyOnceWith("old-source");
    fireEvent.pointerDown(screen.getByRole("button", { name: "common.more" }));
    confirmDialog.mockResolvedValueOnce(false);
    fireEvent.click(await screen.findByText("settings.source.removeSourceServer"));
    const request = confirmDialog.mock.calls.at(-1)?.[0] as unknown as {
      title: string;
      confirmLabel: string;
      description: string;
    };
    expect(request.title).toBe(request.confirmLabel);
    expect(request.description).toContain("Project A (/same-path)");
    expect(request.description).not.toContain("Project B");
  });

  it("reinstalling reuses this device's connection profile instead of opening a blank create form", async () => {
    const snapshot = identityPendingSnapshot("uninstalled", "preferred");
    snapshot.states = [];
    const connect = vi.fn();
    const create = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
        onConnectProfile: connect,
        onCreateConnection: create,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "settings.source.reinstallAndConnect" }),
    );
    expect(connect).toHaveBeenCalledExactlyOnceWith("preferred");
    expect(create).not.toHaveBeenCalled();
  });

  it("an update failure shows the error explanation only once", async () => {
    const snapshot = identityPendingSnapshot("installed", "preferred");
    snapshot.states[0] = {
      profileId: "preferred",
      sourceServerId: "old-source",
      state: "failed",
      errorCode: "remote-host-unreachable",
      error: "Connection refused",
      updateAvailability: "required",
      updatedAt: 2,
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );
    await screen.findByText("Reinstalled server");
    expect(screen.getAllByText("remote.error.hostUnreachable")).toHaveLength(1);
  });

  it("the project count filters out the Source-level conversation backing workspace", () => {
    expect(
      getProjectCount(
        {
          workspaceHistory: [
            {
              sourceServerId: "source-1",
              workspacePath: "/remote/project",
              workspaceIdentity: "remote:server:source-1:/remote/project",
            },
            {
              sourceServerId: "source-1",
              workspacePath: "/remote/.zcode/workspace/default",
              workspaceIdentity: "remote:server:source-1:/remote/.zcode/workspace/default",
            },
          ],
        } as never,
        "source-1",
        {
          "source-1": {
            workspacePath: "/remote/.zcode/workspace/default",
            lastResolvedAt: 1,
          },
        },
      ),
    ).toBe(1);
  });

  it("reloads the authoritative directory snapshot after a state delta", async () => {
    const stateEmitter = new Emitter<{
      generation: number;
      state: SourceServerConnectionStateSnapshot;
    }>();
    const snapshot = (displayName: string, generation: number): SourceServerManagementSnapshot => ({
      generation,
      profiles: [],
      servers: [
        {
          sourceServerId: "3cd4f9da-cd79-426c-9d70-75f36e9f6a87",
          displayName,
          installState: "installed",
        },
      ],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    });
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot("Server A", 0))
      .mockResolvedValueOnce(snapshot("Server B", 1));
    const management = {
      getSnapshot,
      onDidChangeState: stateEmitter.event,
    } as never;

    render(createElement(SourceServerManagementPanel, { management }));
    expect(await screen.findByText("Server A")).toBeTruthy();

    stateEmitter.fire({
      generation: 1,
      state: {
        profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
        state: "online",
        updatedAt: 1,
      },
    });

    await waitFor(() => expect(screen.getByText("Server B")).toBeTruthy());
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("coalesces burst deltas while refresh is in flight", async () => {
    const stateEmitter = new Emitter<{
      generation: number;
      state: SourceServerConnectionStateSnapshot;
    }>();
    const empty: SourceServerManagementSnapshot = {
      generation: 0,
      profiles: [],
      servers: [],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    let resolveRefresh!: (snapshot: SourceServerManagementSnapshot) => void;
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockImplementationOnce(
        async () =>
          await new Promise<SourceServerManagementSnapshot>((resolve) => {
            resolveRefresh = resolve;
          }),
      )
      .mockResolvedValue(empty);
    render(
      createElement(SourceServerManagementPanel, {
        management: { getSnapshot, onDidChangeState: stateEmitter.event } as never,
      }),
    );
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    const state = { profileId: "p", state: "retrying", updatedAt: 1 } as const;
    stateEmitter.fire({ generation: 1, state });
    stateEmitter.fire({ generation: 2, state });
    await Promise.resolve();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    resolveRefresh(empty);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(3));
  });

  it("does not render an unstructured Host error", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "p",
          transport: "docker",
          target: { kind: "docker", container: "dev" },
          sourceServerId: "s",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [
        {
          profileId: "p",
          sourceServerId: "s",
          state: "failed",
          updatedAt: 1,
          error: "raw host detail",
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );
    expect(await screen.findByText("remote.error.unknown")).toBeTruthy();
    expect(screen.queryByText("raw host detail")).toBeNull();
  });

  it("renders concrete recovery attempt values after the retry budget is exhausted", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "p",
          transport: "docker",
          target: { kind: "docker", container: "dev" },
          sourceServerId: "s",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [
        {
          profileId: "p",
          sourceServerId: "s",
          state: "offline",
          updatedAt: 1,
          error: "network unavailable",
          errorCode: "remote-recovery-budget-exhausted",
          recoveryAttempt: 3,
          recoveryLimit: 3,
          recoveryBudgetExhausted: true,
          retryable: true,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );

    expect(await screen.findByText(/remote\.error\.recoveryBudgetExhausted:3\/3/u)).toBeTruthy();
  });

  it("shows version details and server update instead of reconnect when upgrade is required", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "p",
          transport: "docker",
          target: { kind: "docker", container: "dev" },
          sourceServerId: "s",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [
        {
          profileId: "p",
          sourceServerId: "s",
          state: "needs-upgrade",
          updateAvailability: "required",
          currentVersion: "3.6.0",
          minimumVersion: "3.7.0",
          availableVersion: "3.8.0",
          upgradeTarget: "server",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );

    expect(await screen.findByText("settings.source.versionDetails")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "remote.action.connect" })).toBeNull();
    screen.getByRole("button", {
      name: "remote.action.update-server",
    });
    screen.getByRole("button", {
      name: "settings.source.editConnection",
    });
    screen.getByRole("button", { name: "common.more" });
  });

  it("updating overrides the stale update-required copy and shows explicit progress", async () => {
    const operationLogEmitter = new Emitter<{
      profileId: string;
      operation: "update";
      phase: string;
      level: "info";
      message: string;
      progress?: number;
      timestamp: number;
    }>();
    const snapshot: SourceServerManagementSnapshot = {
      generation: 2,
      profiles: [
        {
          profileId: "p",
          transport: "ssh",
          target: { kind: "ssh", host: "h", username: "u" },
          sourceServerId: "s",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [
        {
          profileId: "p",
          sourceServerId: "s",
          state: "updating",
          updateAvailability: "required",
          currentVersion: "3.8.1",
          minimumVersion: "3.9.0",
          availableVersion: "3.9.0",
          upgradeTarget: "server",
          updatedAt: 2,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    let operationLogs: unknown[] = [];
    operationLogEmitter.event((entry) => {
      operationLogs = [{ ...entry, profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d" }];
    });
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          getRecentOperationLogs: vi.fn(async () => operationLogs),
          onDidChangeState: new Emitter().event,
          onDidAppendOperationLog: operationLogEmitter.event,
        } as never,
      }),
    );

    expect(await screen.findByText("settings.source.updateInProgress")).toBeTruthy();
    expect(screen.queryByText("settings.source.updateRequired")).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();

    act(() => {
      operationLogEmitter.fire({
        profileId: "p",
        operation: "update",
        phase: "upload",
        level: "info",
        message: "upload archive",
        progress: 0.5,
        timestamp: 3,
      });
    });
    expect(await screen.findByText("upload archive")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    for (const [phase, messageId] of [
      ["extract", "remote.phaseSub.extracting"],
      ["verify-archive", "remote.phaseSub.verifyingArchive"],
      ["verify", "remote.phaseSub.verifyingFiles"],
      ["restart", "remote.phaseSub.restarting"],
    ]) {
      act(() =>
        operationLogEmitter.fire({
          profileId: "p",
          operation: "update",
          phase: phase!,
          level: "info",
          message: phase!,
          timestamp: 4,
        }),
      );
      expect(await screen.findByText(messageId!)).toBeTruthy();
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
    }
  });

  it("edits the preferred connection in a dialog instead of inline", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "p",
          transport: "docker",
          displayName: "old name",
          target: { kind: "docker", container: "dev" },
          sourceServerId: "s",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const getSnapshot = vi.fn(async () => snapshot);
    render(
      createElement(SourceServerManagementPanel, {
        management: { getSnapshot, onDidChangeState: stateEmitter.event } as never,
      }),
    );
    expect(await screen.findByText("Dev")).toBeTruthy();
    expect(screen.queryByDisplayValue("Dev")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "settings.source.editConnection" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByDisplayValue("Dev")).toBeTruthy();
  });

  it("before startup connects, historical failures are not re-shown as the current fault", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "p",
          transport: "ssh",
          displayName: "line",
          target: { kind: "ssh", host: "h", username: "u" },
          sourceServerId: "s",
          lastConnectError: "auth rejected",
          createdAt: 1,
        },
      ],
      servers: [{ sourceServerId: "s", displayName: "Dev", installState: "installed" }],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: stateEmitter.event,
        } as never,
      }),
    );
    expect(await screen.findByText("remote.status.offline")).toBeTruthy();
    expect(screen.queryByText("settings.source.lastConnectError")).toBeNull();
  });

  it("shows one primary connection and collapses other saved connections", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "primary",
          transport: "ssh",
          displayName: "primary connection",
          target: { kind: "ssh", host: "primary.example.com", username: "dev" },
          sourceServerId: "source",
          createdAt: 1,
          lifecycleState: "active",
        },
        {
          profileId: "backup",
          transport: "ssh",
          displayName: "backup connection",
          target: { kind: "ssh", host: "backup.example.com", username: "dev" },
          sourceServerId: "source",
          createdAt: 2,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source",
          displayName: "Build server",
          preferredProfileId: "primary",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          updateProfile: vi.fn(),
        } as never,
      }),
    );

    expect(await screen.findByText("Build server")).toBeTruthy();
    expect(document.querySelector('[data-remote-connection-status="offline"]')).toBeTruthy();
    expect(document.querySelector('[data-remote-connection-kind="ssh"]')).toBeTruthy();
    expect(screen.getByText("dev@primary.example.com:22")).toBeTruthy();
    expect(screen.queryByText("dev@backup.example.com:22")).toBeNull();
    expect(
      screen.getAllByRole("button", {
        name: "settings.source.editConnection",
      }),
    ).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.source.otherSavedConnections",
      }),
    );
    screen.getByText("dev@backup.example.com:22");
    expect(screen.getByRole("button", { name: "settings.source.setDefault" })).toBeTruthy();
  });

  it("unrecognized connections appear only in the collapsed-by-default unfinished area", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "unbound-profile",
          transport: "ssh",
          displayName: "linux-arm64-dev",
          target: {
            kind: "ssh",
            host: "localhost",
            port: 2223,
            username: "dev",
            sshConfigAlias: "linux-arm64-dev",
          },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      servers: [],
      workspaceHistory: [],
      states: [
        {
          profileId: "unbound-profile",
          state: "offline",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const { container } = render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          removeProfile: vi.fn(),
        } as never,
      }),
    );

    expect(await screen.findByText("settings.source.unfinishedConnections")).toBeTruthy();
    const unfinished = container.querySelector("[data-unfinished-connections]");
    expect(unfinished?.tagName).toBe("DETAILS");
    expect(unfinished?.hasAttribute("open")).toBe(false);
    expect(container.querySelector("[data-source-server-card]")).toBeNull();
    fireEvent.click(screen.getByText("settings.source.unfinishedConnections"));
    expect(screen.getByText("linux-arm64-dev")).toBeTruthy();
    expect(container.querySelector('[data-remote-connection-status="offline"]')).toBeTruthy();
    expect(screen.getByText("dev@localhost:2223")).toBeTruthy();
    const preferences = screen.getByText("settings.source.connectionPreferences");
    expect(
      unfinished!.compareDocumentPosition(preferences) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Without recognized devices, the device-list heading is not shown.
    expect(screen.queryByText("settings.source.devicesHeading")).toBeNull();
  });

  it("does not expose migration diagnostics in the regular connection menu", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          transport: "ssh",
          target: { kind: "ssh", host: "example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Build server",
          preferredProfileId: "profile-a",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          state: "online",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [
        {
          sourceServerId: "source-a",
          status: "available",
          failedPathCount: 0,
          abandonedPathCount: 0,
        },
      ],
    };
    const getMigrationReport = vi.fn();
    const exportMigrationReport = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          getMigrationReport,
          exportMigrationReport,
        } as never,
      }),
    );

    expect(await screen.findByText("Build server")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "common.more" }));

    expect(screen.queryByText("settings.source.migrationReport")).toBeNull();
    expect(screen.queryByText("settings.source.exportMigrationJson")).toBeNull();
    expect(getMigrationReport).not.toHaveBeenCalled();
    expect(exportMigrationReport).not.toHaveBeenCalled();
  });

  it("keeps a user-facing connection-history alert for pending migration work", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          transport: "ssh",
          target: { kind: "ssh", host: "example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Build server",
          preferredProfileId: "profile-a",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          state: "online",
          updatedAt: 1,
        },
      ],
      failedPathCount: 1,
      abandonedPathCount: 0,
      migrationCounts: [
        {
          sourceServerId: "source-a",
          status: "available",
          failedPathCount: 1,
          abandonedPathCount: 0,
        },
      ],
    };
    const getMigrationReport = vi.fn(async () => ({ rows: [] }));
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          getMigrationReport,
        } as never,
      }),
    );

    expect(await screen.findByText("settings.source.connectionHistoryNeedsAttention")).toBeTruthy();
    expect(screen.queryByText(/product boundary/iu)).toBeNull();
    expect(screen.queryByText("settings.source.migrationReport")).toBeNull();
    expect(screen.queryByText("settings.source.exportMigrationJson")).toBeNull();

    fireEvent.click(screen.getByText("settings.source.connectionHistoryNeedsAttention"));
    expect(await screen.findByText("settings.source.noMigrationIssues")).toBeTruthy();
    expect(getMigrationReport).toHaveBeenCalledWith("source-a");
    expect(screen.queryByRole("button", { name: /exportMigrationReport/u })).toBeNull();
  });

  it("routes every user connection action through the global dialog profile intent", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "bound-profile",
          sourceServerId: "source-a",
          transport: "ssh",
          target: { kind: "ssh", host: "bound.example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
        {
          profileId: "unbound-profile",
          transport: "docker",
          target: { kind: "docker", container: "pending-dev" },
          createdAt: 2,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Build server",
          preferredProfileId: "bound-profile",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const connectProfile = vi.fn();
    const onConnectProfile = vi.fn();
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          connectProfile,
        } as never,
        onConnectProfile,
      }),
    );

    expect(await screen.findByText("Build server")).toBeTruthy();
    fireEvent.click(screen.getByText("settings.source.unfinishedConnections"));
    const connectButtons = screen.getAllByRole("button", {
      name: "remote.action.connect",
    });
    expect(connectButtons).toHaveLength(2);
    await act(async () => fireEvent.click(connectButtons[0]!));
    await act(async () => fireEvent.click(connectButtons[1]!));

    expect(onConnectProfile.mock.calls).toEqual([["bound-profile"], ["unbound-profile"]]);
    expect(connectProfile).not.toHaveBeenCalled();
  });

  it("routes device disconnect through the injected remote controller adapter", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          transport: "ssh",
          target: { kind: "ssh", host: "example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Build server",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          state: "online",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const onDisconnectSource = vi.fn(async () => undefined);
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
        } as never,
        onDisconnectSource,
      }),
    );

    expect(await screen.findByText("Build server")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "remote.action.disconnect" }));
    await waitFor(() => expect(onDisconnectSource).toHaveBeenCalledWith("source-a"));
  });

  it("the offline device's more menu still offers removal and calls the Host removal", async () => {
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      profiles: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          transport: "ssh",
          target: { kind: "ssh", host: "example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Build server",
          preferredProfileId: "profile-a",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [
        {
          profileId: "profile-a",
          sourceServerId: "source-a",
          state: "offline",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const removeSourceServer = vi.fn(async () => ({
      ...snapshot,
      generation: 2,
      profiles: [],
      servers: [],
      states: [],
    }));
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: vi.fn(async () => snapshot),
          onDidChangeState: new Emitter().event,
          removeSourceServer,
        } as never,
        onShowInSidebar: vi.fn(),
      }),
    );

    expect(await screen.findByText("Build server")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "common.more" }));
    // The offline device is not shown in the sidebar, but removal only deletes
    // local records and does not depend on the connection.
    expect(await screen.findByText("settings.source.removeSourceServer")).toBeTruthy();
    expect(screen.queryByText("settings.source.showInSidebar")).toBeNull();
    const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');
    expect(screen.getByText("settings.source.copyDeviceId")).toBeTruthy();
    expect(menu?.querySelector("[data-device-info]")?.textContent).toContain("source-a");

    fireEvent.click(screen.getByText("settings.source.removeSourceServer"));
    await waitFor(() => expect(removeSourceServer).toHaveBeenCalledWith("source-a"));
  });
});

it("the management entry focuses the device card once the snapshot arrives and consumes the intent once; a plain remount does not steal focus", async () => {
  const snapshot = identityPendingSnapshot("installed", "preferred");
  const pending = Promise.withResolvers<typeof snapshot>();
  const management = {
    getSnapshot: () => pending.promise,
    onDidChangeState: new Emitter().event,
  } as never;
  const consumed = vi.fn();
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  const view = render(
    createElement(SourceServerManagementPanel, {
      management,
      targetSourceServerId: "old-source",
      onTargetSourceServerFocused: consumed,
    }),
  );
  expect(consumed).not.toHaveBeenCalled();
  await act(async () => pending.resolve(snapshot));
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("data-source-server-card")).toBe("old-source"),
  );
  expect(consumed).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenCalledWith({ block: "center" });
  view.unmount();
  render(createElement(SourceServerManagementPanel, { management }));
  await screen.findByText("Reinstalled server");
  expect(scroll).toHaveBeenCalledOnce();
  expect(document.activeElement?.getAttribute("data-source-server-card")).toBeNull();
});

it("device actions dedupe per Source; unrelated devices and read-only expansion continue; out-of-order snapshots do not roll back", async () => {
  const snapshot = identityPendingSnapshot("installed", "other");
  snapshot.states.forEach((state) => {
    state.state = "online";
    state.updateAvailability = "available";
    state.availableVersion = "2.0.0";
  });
  snapshot.servers.push({
    ...snapshot.servers[0]!,
    sourceServerId: "second",
    displayName: "Second",
    preferredProfileId: "second",
  });
  snapshot.profiles.push({
    ...snapshot.profiles[0]!,
    sourceServerId: "second",
    profileId: "second",
  });
  snapshot.states.push({
    ...snapshot.states[0]!,
    sourceServerId: "second",
    profileId: "second",
    state: "online",
  });
  snapshot.states[1] = {
    ...snapshot.states[1]!,
    state: "failed",
    errorCode: "remote-permission-denied",
  };
  const first = Promise.withResolvers<SourceServerManagementSnapshot>();
  const second = Promise.withResolvers<SourceServerManagementSnapshot>();
  const updateSource = vi.fn(({ profileId }: { profileId: string }) =>
    profileId === "second" ? second.promise : first.promise,
  );
  const management = {
    getSnapshot: async () => snapshot,
    onDidChangeState: new Emitter().event,
    updateSource,
  } as never;
  const { container } = render(
    createElement(SourceServerManagementPanel, {
      management,
      onDisconnectSource: vi.fn(async () => {}),
    }),
  );
  await screen.findByText("Second");
  const card = (id: string) => container.querySelector(`[data-source-server-card="${id}"]`)!;
  const action = (id: string) =>
    Array.from(card(id).querySelectorAll("button")).find(
      (button) => button.textContent === "remote.action.update-server",
    )!;
  fireEvent.click(action("old-source"));
  fireEvent.click(action("old-source"));
  expect(updateSource).toHaveBeenCalledTimes(1);
  expect(
    card("second")
      .querySelector('button[aria-label="settings.source.editConnection"]')!
      .matches(":disabled"),
  ).toBe(false);
  const expand = card("old-source").querySelector(
    'button[aria-label="settings.source.otherSavedConnections"]',
  )!;
  expect(expand.matches(":disabled")).toBe(false);
  fireEvent.click(expand);
  const otherLine = screen.getByText("dev@other.example.com:22").parentElement!;
  const lineButton = (name: string) =>
    Array.from(otherLine.querySelectorAll("button")).find((button) => button.textContent === name)!;
  expect(lineButton("remote.action.details").matches(":disabled")).toBe(false);
  expect(lineButton("settings.source.setDefault").matches(":disabled")).toBe(true);
  expect(lineButton("settings.source.removeProfile").matches(":disabled")).toBe(true);
  expect(
    card("old-source")
      .querySelector('button[aria-label="settings.source.editConnection"]')!
      .matches(":disabled"),
  ).toBe(true);
  fireEvent.click(action("second"));
  expect(updateSource).toHaveBeenCalledTimes(2);
  await act(async () =>
    second.resolve({
      ...snapshot,
      generation: 3,
      servers: snapshot.servers.map((server) => ({
        ...server,
        displayName: `${server.displayName} latest`,
      })),
    }),
  );
  await screen.findByText("Second latest");
  await act(async () => first.resolve({ ...snapshot, generation: 2 }));
  expect(screen.queryByText("Second")).toBeNull();
  expect(screen.getByText("Second latest")).toBeTruthy();
});

it("managing a failed device only focuses it; an explicit details intent opens the dialog and the same device can consume it again", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const snapshot = identityPendingSnapshot("installed", "preferred");
  snapshot.states[0] = {
    ...snapshot.states[0]!,
    state: "failed",
    errorCode: "remote-host-unreachable",
    error: "connect ECONNREFUSED",
  };
  const management = {
    getSnapshot: async () => snapshot,
    onDidChangeState: new Emitter().event,
  } as never;
  const view = render(
    createElement(SourceServerManagementPanel, { management, targetSourceServerId: "old-source" }),
  );
  await screen.findByText("Reinstalled server");
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(createElement(SourceServerManagementPanel, { management }));
  view.rerender(
    createElement(SourceServerManagementPanel, {
      management,
      targetSourceServerId: "old-source",
      targetSourceServerDetails: true,
    }),
  );
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

it.each([false, true])(
  "an optional update does not swallow the same device's connection failure reason (same profile: %s)",
  async (sameProfile) => {
    const snapshot = identityPendingSnapshot("installed", "other");
    snapshot.states[0] = {
      ...snapshot.states[0]!,
      state: "failed",
      errorCode: "remote-host-unreachable",
      error: "connect ECONNREFUSED",
      updatedAt: 2,
    };
    snapshot.states[1] = { ...snapshot.states[1]!, state: "offline" };
    Object.assign(snapshot.states[sameProfile ? 0 : 1]!, {
      updateAvailability: "available",
      availableVersion: "2.0.0",
    });
    render(
      createElement(SourceServerManagementPanel, {
        management: {
          getSnapshot: async () => snapshot,
          onDidChangeState: new Emitter().event,
        } as never,
      }),
    );
    await screen.findByText("Reinstalled server");
    expect(screen.getByText("remote.error.hostUnreachable")).toBeTruthy();
    if (!sameProfile)
      expect(screen.getByText("settings.source.updateAvailableVersion")).toBeTruthy();
  },
);

it("after the same connection's optional update is deferred, the connection failure reason still shows", async () => {
  const snapshot = identityPendingSnapshot("installed", "preferred");
  snapshot.states[0] = {
    ...snapshot.states[0]!,
    state: "failed",
    errorCode: "remote-host-unreachable",
    updateAvailability: "available",
    availableVersion: "deferred-regression",
  };
  render(
    createElement(SourceServerManagementPanel, {
      management: {
        getSnapshot: async () => snapshot,
        onDidChangeState: new Emitter().event,
      } as never,
    }),
  );
  await screen.findByText("remote.error.hostUnreachable");
  fireEvent.click(screen.getByRole("button", { name: "updateDialog.later" }));
  expect(screen.getByText("remote.error.hostUnreachable")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "updateDialog.later" })).toBeNull();
});
