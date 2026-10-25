// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DockerContainerInfo,
  SourceServerManagementSnapshot,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import enUS from "@/i18n/locales/en-US.js";

/**
 * RDUX-27: header, type switching, SSH config import, paste splitting, inline validation and
 * both entry footers of the new-connection form. Mounts the real wizard
 * (useRemoteConnectionFlow + SSHDialog), replacing only the service ports.
 */
const ports = vi.hoisted(() => ({
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
  },
  platform: {
    isLocalDevelopmentRuntime: false,
    isDockerAvailable: vi.fn(async () => true),
    listSSHConfigAliases: vi.fn(async (): Promise<SSHConfigAliasOption[]> => []),
    listWSLDistros: vi.fn(async (): Promise<WSLDistro[]> => []),
    listDockerContainers: vi.fn(async (): Promise<DockerContainerInfo[]> => []),
    onRemoteConnectionLog: vi.fn(() => () => undefined),
    cancelPendingRemoteConnection: vi.fn(async () => undefined),
    selectFile: vi.fn(async () => null),
  },
  confirm: vi.fn(async () => true),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }, values: Record<string, string> = {}) =>
        ((enUS as Record<string, string>)[id] ?? id).replace(
          /\{(\w+)\}/gu,
          (_, key) => values[key] ?? `{${key}}`,
        ),
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
const mountSettingsEntry = (overrides: Partial<DialogProps> = {}) =>
  mountDialog({ completion: "device-management", ...overrides });

const aliases: SSHConfigAliasOption[] = [
  {
    alias: "gpu",
    host: "gpu.example.com",
    username: "ubuntu",
    port: 2222,
    privateKeyPath: "~/.ssh/gpu.pem",
  },
  { alias: "staging", host: "staging.example.com", username: "deploy" },
];

function pasteInto(element: HTMLElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(event, { clipboardData: { getData: () => text } });
  fireEvent(element, event);
  return event;
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
  ports.platform.isDockerAvailable.mockResolvedValue(true);
  ports.platform.listSSHConfigAliases.mockResolvedValue([]);
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
  useRemoteWorkspaceSessionStore.setState({ sessionsById: {} });
});
afterEach(cleanup);

describe("new-connection form from the settings entry", () => {
  it("has no step bar or description sentence; live target preview under the title; focus on the host", async () => {
    mountSettingsEntry();
    const host = await screen.findByTestId("ssh-host-input");
    expect(screen.getByRole("heading", { name: enUS["remote.settingsStepTitle"] })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: enUS["remote.wizard"] })).toBeNull();
    expect(screen.queryByText(/Enter the details/)).toBeNull();
    const preview = screen.getByTestId("remote-new-connection-preview");
    expect(preview.textContent).toBe("user@host:22");
    await waitFor(() => expect(document.activeElement).toBe(host));

    fireEvent.change(host, { target: { value: "10.0.0.5" } });
    fireEvent.change(screen.getByTestId("ssh-username-input"), { target: { value: "root" } });
    expect(preview.textContent).toBe("root@10.0.0.5:22");
  });

  it("type switching carries the type color and marks the selection; the auth method stays neutral", async () => {
    mountSettingsEntry();
    const kinds = await screen.findByRole("group", { name: enUS["remote.connectionType"] });
    const ssh = within(kinds).getByTestId("remote-kind-ssh");
    expect(ssh.getAttribute("aria-pressed")).toBe("true");
    expect(ssh.className).toContain("bg-remote-ssh-surface");
    fireEvent.click(within(kinds).getByTestId("remote-kind-docker"));
    const docker = within(kinds).getByTestId("remote-kind-docker");
    expect(docker.getAttribute("aria-pressed")).toBe("true");
    expect(docker.className).toContain("bg-remote-docker-surface");
    expect(ssh.className).not.toContain("bg-remote-ssh-surface");
    fireEvent.click(ssh);
    const auth = screen.getByRole("group", { name: enUS["ssh.authMethod"] });
    expect(within(auth).getByRole("button", { pressed: true }).className).not.toMatch(
      /bg-remote-/u,
    );
  });

  it("after importing from SSH config shows the linked chip, focuses the first empty required field, and × only unlinks", async () => {
    ports.platform.listSSHConfigAliases.mockResolvedValue(aliases);
    mountSettingsEntry();
    const importButton = await screen.findByTestId("remote-ssh-config-import");
    await waitFor(() => expect((importButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(importButton);
    fireEvent.click(await screen.findByText("staging"));

    const chip = await screen.findByTestId("remote-ssh-config-alias-chip");
    expect(chip.textContent).toContain(enUS["ssh.configAliasLinked"].replace("{alias}", "staging"));
    expect(chip.className).toContain("bg-remote-ssh-surface");
    expect((screen.getByTestId("ssh-host-input") as HTMLInputElement).value).toBe(
      "staging.example.com",
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("ssh-password-input")),
    );

    fireEvent.click(within(chip).getByRole("button", { name: enUS["ssh.configAliasUnlink"] }));
    expect(screen.queryByTestId("remote-ssh-config-alias-chip")).toBeNull();
    expect((screen.getByTestId("ssh-host-input") as HTMLInputElement).value).toBe(
      "staging.example.com",
    );
  });

  it("focus moves to the primary action when the imported Host already has a private key", async () => {
    ports.platform.listSSHConfigAliases.mockResolvedValue(aliases);
    mountSettingsEntry();
    const importButton = await screen.findByTestId("remote-ssh-config-import");
    await waitFor(() => expect((importButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(importButton);
    fireEvent.click(await screen.findByText("gpu"));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: enUS["remote.addAndConnect"] }),
      ),
    );
  });

  it("with no config Hosts the import button is disabled and explains why", async () => {
    mountSettingsEntry();
    const importButton = await screen.findByTestId("remote-ssh-config-import");
    await waitFor(() => expect(importButton.textContent).toContain(enUS["ssh.importEmpty"]));
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("pasting an ssh command splits host, username and port, and unlinks the alias", async () => {
    ports.platform.listSSHConfigAliases.mockResolvedValue(aliases);
    mountSettingsEntry();
    const importButton = await screen.findByTestId("remote-ssh-config-import");
    await waitFor(() => expect((importButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(importButton);
    fireEvent.click(await screen.findByText("staging"));
    await screen.findByTestId("remote-ssh-config-alias-chip");

    const host = screen.getByTestId("ssh-host-input");
    const event = pasteInto(host, "ssh root@10.0.0.5 -p 2222");
    expect(event.defaultPrevented).toBe(true);
    expect((host as HTMLInputElement).value).toBe("10.0.0.5");
    expect((screen.getByTestId("ssh-username-input") as HTMLInputElement).value).toBe("root");
    expect((screen.getByTestId("ssh-port-input") as HTMLInputElement).value).toBe("2222");
    expect(
      screen.getByText(enUS["ssh.pasteRecognized"].replace("{target}", "root@10.0.0.5:2222")),
    ).toBeTruthy();
    expect(screen.queryByTestId("remote-ssh-config-alias-chip")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("ssh-password-input")),
    );

    // After a manual host edit the recognition hint disappears; non-matching text falls through
    // to the browser's default paste.
    fireEvent.change(host, { target: { value: "10.0.0.6" } });
    expect(screen.queryByText(/Recognized/)).toBeNull();
    expect(pasteInto(host, "plain-host").defaultPrevented).toBe(false);
  });

  it("submit shows errors under the fields, focuses the first invalid field, and errors clear after fixing", async () => {
    const { props } = mountSettingsEntry();
    const host = await screen.findByTestId("ssh-host-input");
    fireEvent.click(screen.getByRole("button", { name: enUS["remote.addAndConnect"] }));

    const hostError = (await screen.findByText(enUS["ssh.validation.hostRequired"])).closest("p")!;
    expect(host.getAttribute("aria-invalid")).toBe("true");
    expect(host.getAttribute("aria-describedby")).toBe(hostError.id);
    expect(screen.getByText(enUS["ssh.validation.usernameRequired"])).toBeTruthy();
    expect(screen.getByText(enUS["ssh.validation.passwordRequired"])).toBeTruthy();
    expect(document.activeElement).toBe(host);
    expect(props.onConnect).not.toHaveBeenCalled();

    fireEvent.change(host, { target: { value: "10.0.0.5" } });
    expect(screen.queryByText(enUS["ssh.validation.hostRequired"])).toBeNull();
    expect(host.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByText(enUS["ssh.validation.usernameRequired"])).toBeTruthy();
  });

  it("the settings entry footer offers cancel and add-and-connect", async () => {
    mountSettingsEntry();
    const submit = await screen.findByRole("button", { name: enUS["remote.addAndConnect"] });
    const footer = submit.parentElement!;
    expect(within(footer).getByRole("button", { name: enUS["common.cancel"] })).toBeTruthy();
  });

  it("Docker has no description block; when unavailable it warns under the picker", async () => {
    ports.platform.isDockerAvailable.mockResolvedValue(false);
    mountSettingsEntry();
    fireEvent.click(await screen.findByTestId("remote-kind-docker"));
    fireEvent.click(screen.getByRole("button", { name: enUS["docker.inputMode.select"] }));
    const warning = await screen.findByText(enUS["docker.unavailable"]);
    expect(warning.closest("[data-remote-field-hint=warning]")).toBeTruthy();
    expect(screen.queryByText(enUS["docker.description"])).toBeNull();
    expect(screen.getByTestId("remote-new-connection-preview").textContent).toBe(
      enUS["docker.selectContainer"],
    );
  });

  it.each([
    ["Docker unavailable", false, "docker.unavailable"],
    ["No running containers", true, "docker.noContainers"],
  ] as const)(
    "%s: opening the container dropdown explains the empty list",
    async (_, available, messageId) => {
      ports.platform.isDockerAvailable.mockResolvedValue(available);
      mountSettingsEntry();
      fireEvent.click(await screen.findByTestId("remote-kind-docker"));
      fireEvent.click(screen.getByRole("button", { name: enUS["docker.inputMode.select"] }));
      await screen.findByText(enUS[messageId]);
      fireEvent.click(screen.getByTestId("docker-container-select"));
      const list = await screen.findByRole("listbox");
      expect(within(list).getByText(enUS[messageId])).toBeTruthy();
      expect(within(list).queryByText(enUS["docker.selectContainer"])).toBeNull();
    },
  );
});

describe("new SSH connection form from the project/chat entry", () => {
  it("keeps the three-step bar, type label and back-to-list entry, and hides the alias entry", async () => {
    ports.platform.listSSHConfigAliases.mockResolvedValue(aliases);
    mountDialog();
    fireEvent.click(await screen.findByRole("button", { name: enUS["remote.selection.new.ssh"] }));
    await screen.findByTestId("ssh-host-input");

    const steps = screen.getByRole("navigation", { name: enUS["remote.wizard"] });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: enUS["remote.settingsStepTitle"] })).toBeTruthy();
    expect(document.querySelector("[data-remote-connection-kind=ssh]")).toBeTruthy();
    expect(screen.queryByTestId("remote-ssh-config-import")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(screen.queryByTestId("ssh-config-alias-select")).toBeNull();

    const back = screen.getByRole("button", { name: enUS["remote.selection.back"] });
    const footer = back.parentElement!;
    expect(footer.lastElementChild!.textContent).toBe(enUS["remote.startConnection"]);
  });
});
