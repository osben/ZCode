// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SourceServerManagementSnapshot,
  SSHConfigAliasOption,
  DockerContainerInfo,
  WSLDistro,
} from "@zcode/shared";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const ports = vi.hoisted(() => ({
  locale: "en-US",
  snapshot: {} as SourceServerManagementSnapshot,
  credentialService: { load: vi.fn(async () => null), save: vi.fn() },
  settingService: {
    get: vi.fn(async () => ({ remoteBoundaryIntroAcknowledgedVersion: 1 })),
    update: vi.fn(async () => undefined),
  },
  management: {
    getSnapshot: vi.fn(),
    onDidChangeState: () => ({ dispose() {} }),
    onDidChangeDirectory: () => ({ dispose() {} }),
    updateSource: vi.fn(),
    confirmIdentityChange: vi.fn(),
    trustHostKey: vi.fn(),
  },
  platform: {
    isLocalDevelopmentRuntime: true,
    isDockerAvailable: vi.fn(async () => true),
    listSSHConfigAliases: vi.fn(async (): Promise<SSHConfigAliasOption[]> => []),
    listWSLDistros: vi.fn(async (): Promise<WSLDistro[]> => []),
    listDockerContainers: vi.fn(async (): Promise<DockerContainerInfo[]> => []),
    onRemoteConnectionLog: vi.fn(() => () => undefined),
    cancelPendingRemoteConnection: vi.fn(async () => undefined),
  },
  confirm: vi.fn(async () => true),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: ports.locale,
    intl: {
      formatMessage: ({ id }: { id: string }, values: Record<string, string> = {}) => {
        const messages: Record<string, string> = ports.locale === "en-US" ? enUS : zhCN;
        return (messages[id] ?? id).replace(/\{(\w+)\}/gu, (_, key) => values[key] ?? `{${key}}`);
      },
    },
  }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ ...ports, sourceServerManagementService: ports.management }),
  useOptionalBaseWorkspaceServices: () => ({
    ...ports,
    sourceServerManagementService: ports.management,
  }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ports.platform,
  useOptionalPlatform: () => ports.platform,
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => ports.confirm }));

import { RemoteConnectionDialog } from "@/SSHDialog.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

type DialogProps = ComponentProps<typeof RemoteConnectionDialog>;
function mountDialog(overrides: Partial<DialogProps> = {}) {
  const props: DialogProps = {
    open: true,
    onConnect: vi.fn(async () => "session-a"),
    onSelectProject: vi.fn(async () => undefined),
    onCancelSession: vi.fn(async () => undefined),
    ...overrides,
  };
  return { ...render(createElement(RemoteConnectionDialog, props)), props };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.unstubAllEnvs();
  ports.platform.isLocalDevelopmentRuntime = true;
  ports.platform.isDockerAvailable.mockResolvedValue(true);
  ports.locale = "en-US";
  ports.platform.listSSHConfigAliases.mockResolvedValue([]);
  ports.platform.listWSLDistros.mockResolvedValue([]);
  ports.platform.listDockerContainers.mockResolvedValue([]);
  ports.snapshot = {
    generation: 1,
    servers: [],
    profiles: [],
    states: [],
    workspaceHistory: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
  ports.management.getSnapshot.mockImplementation(async () => ports.snapshot);
  ports.management.confirmIdentityChange.mockImplementation(async () => ports.snapshot);
  useRemoteWorkspaceSessionStore.setState({ sessionsById: {} });
});

afterEach(() => {
  cleanup();
});

const profileId = "0b6f6d1e-5d0c-4b8e-9f43-2b7f2b3f6a11";
// Fake fingerprint for the test; never a real host key.
const hostKeyPreview = { keyType: "ssh-ed25519", fingerprint: "SHA256:fakeFingerprintForTests" };

function hostKeyUnknownError() {
  return Object.assign(new Error("SSH host key is not in known_hosts"), {
    code: "remote-host-key-unknown",
    retryable: false,
    profileId,
  });
}

function withPendingHostKey() {
  ports.snapshot.states = [
    {
      profileId,
      state: "failed",
      errorCode: "remote-host-key-unknown",
      retryable: false,
      hostKeyPreview,
      updatedAt: 1,
    },
  ];
}

async function clickStart() {
  fireEvent.click(
    await screen.findByRole("button", { name: expectedCopy("remote.startConnection") }),
  );
}

describe("SSH host key trust prompt", () => {
  it("shows the key type and fingerprint, trusts that exact key, then connects again", async () => {
    withPendingHostKey();
    ports.management.trustHostKey.mockImplementation(async () => {
      ports.snapshot.states = [];
      return ports.snapshot;
    });
    const onConnect = vi
      .fn()
      .mockRejectedValueOnce(hostKeyUnknownError())
      .mockResolvedValueOnce("session-a");
    mountDialog({ preferredTarget: { kind: "docker", container: "dev" }, onConnect });
    await clickStart();

    const panel = await screen.findByTestId("remote-host-key-trust");
    expect(within(panel).getByTestId("remote-host-key-type").textContent).toBe("ssh-ed25519");
    expect(within(panel).getByTestId("remote-host-key-fingerprint").textContent).toBe(
      hostKeyPreview.fingerprint,
    );
    expect(screen.queryByTestId("ssh-error")).toBeNull();

    fireEvent.click(within(panel).getByTestId("remote-host-key-trust-confirm"));
    await waitFor(() =>
      expect(ports.management.trustHostKey).toHaveBeenCalledWith(
        profileId,
        hostKeyPreview.fingerprint,
      ),
    );
    await screen.findByTestId("ssh-success");
    expect(onConnect).toHaveBeenCalledTimes(2);
  });

  it("rejecting writes nothing, does not reconnect and explains why", async () => {
    withPendingHostKey();
    const onConnect = vi.fn().mockRejectedValueOnce(hostKeyUnknownError());
    mountDialog({ preferredTarget: { kind: "docker", container: "dev" }, onConnect });
    await clickStart();

    const panel = await screen.findByTestId("remote-host-key-trust");
    fireEvent.click(within(panel).getByTestId("remote-host-key-trust-cancel"));
    await screen.findByText(expectedCopy("remote.hostKeyTrustRejected"));
    expect(screen.queryByTestId("remote-host-key-trust")).toBeNull();
    expect(ports.management.trustHostKey).not.toHaveBeenCalled();
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("after rejecting, the primary action connects again and brings the prompt back", async () => {
    withPendingHostKey();
    const onConnect = vi
      .fn()
      .mockRejectedValueOnce(hostKeyUnknownError())
      .mockRejectedValueOnce(hostKeyUnknownError());
    mountDialog({ preferredTarget: { kind: "docker", container: "dev" }, onConnect });
    await clickStart();
    fireEvent.click(
      within(await screen.findByTestId("remote-host-key-trust")).getByTestId(
        "remote-host-key-trust-cancel",
      ),
    );
    await screen.findByText(expectedCopy("remote.hostKeyTrustRejected"));
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("remote.action.retry") }));
    await screen.findByTestId("remote-host-key-trust");
    expect(onConnect).toHaveBeenCalledTimes(2);
    expect(ports.management.trustHostKey).not.toHaveBeenCalled();
  });

  it("a changed host key shows the refusal without any trust option", async () => {
    const onConnect = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("SSH host key does not match known_hosts"), {
        code: "remote-host-key-changed",
        retryable: false,
      }),
    );
    mountDialog({ preferredTarget: { kind: "docker", container: "dev" }, onConnect });
    await clickStart();

    await screen.findAllByText(expectedCopy("remote.error.hostKeyChanged"));
    expect(screen.queryByTestId("remote-host-key-trust")).toBeNull();
    expect(ports.management.trustHostKey).not.toHaveBeenCalled();
  });
});
