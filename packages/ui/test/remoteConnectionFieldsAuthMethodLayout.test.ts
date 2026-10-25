// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { RemoteConnectionFields } from "@/RemoteConnectionFields.js";
import type { IPlatformService } from "@zcode/shared";
import { expectedCopy } from "./helpers/uiCopy.js";

const platform: IPlatformService = {
  activateOrSetWorkspace: vi.fn(),
  cancelRemoteConnection: vi.fn(),
  connectRemote: vi.fn(),
  detectShell: vi.fn(),
  getDataBaseDir: vi.fn(),
  getDefaultShell: vi.fn(),
  getShells: vi.fn(),
  isDockerAvailable: vi.fn(),
  isWindowsDesktop: vi.fn(),
  listDockerContainers: vi.fn(),
  listSSHConfigAliases: vi.fn(),
  listWSLDistros: vi.fn(),
  log: vi.fn(),
  notifyRendererReady: vi.fn(),
  onOAuthCallback: vi.fn(),
  onRemoteConnectionLog: vi.fn(),
  openExternal: vi.fn(),
  registerOAuthState: vi.fn(),
  selectDirectory: vi.fn(),
  selectFile: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function renderRemoteConnectionFields(
  locale: "en-US" | "zh-CN" = "en-US",
  overrides: Partial<ComponentProps<typeof RemoteConnectionFields>> = {},
) {
  return render(
    createElement(
      PlatformProvider,
      { platform },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(RemoteConnectionFields, {
          kind: "ssh",
          host: "",
          port: "22",
          username: "",
          sshAuthMethod: "password",
          assetInstallMode: "local-download-upload",
          password: "",
          privateKeyPath: "",
          privateKeyPassphrase: "",
          wslDistro: "",
          wslDistros: [],
          dockerContainer: "",
          manualDockerContainer: "",
          serverUrl: "",
          serverName: "",
          serverToken: "",
          serverWorkspacePath: "",
          dockerContainers: [],
          dockerAvailable: null,
          sshConfigAliases: [],
          sshConfigAliasesLoading: false,
          sshConfigAliasesError: "",
          selectedSshConfigAlias: null,
          runtimeOptionsLoading: false,
          applySshConfigAlias: vi.fn(),
          clearSelectedSshConfigAlias: vi.fn(),
          setHost: vi.fn(),
          setPort: vi.fn(),
          setUsername: vi.fn(),
          setSshAuthMethod: vi.fn(),
          setAssetInstallMode: vi.fn(),
          setPassword: vi.fn(),
          setPrivateKeyPath: vi.fn(),
          setPrivateKeyPassphrase: vi.fn(),
          setWslDistro: vi.fn(),
          setDockerContainer: vi.fn(),
          setManualDockerContainer: vi.fn(),
          setServerUrl: vi.fn(),
          setServerName: vi.fn(),
          setServerToken: vi.fn(),
          setServerWorkspacePath: vi.fn(),
          ...overrides,
        }),
      ),
    ),
  );
}

it("auth and download methods have group names and pressed state, and the password can be shown then hidden", () => {
  renderRemoteConnectionFields();
  const auth = screen.getByRole("group", {
    name: expectedCopy("ssh.authMethod"),
  });
  expect(within(auth).getByRole("button", { pressed: true }).textContent).toBe(
    expectedCopy("ssh.auth.password"),
  );
  const password = screen.getByLabelText(expectedCopy("ssh.password"));
  expect(password.getAttribute("type")).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: expectedCopy("ssh.showPassword") }));
  expect(password.getAttribute("type")).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: expectedCopy("ssh.hidePassword") }));
  expect(password.getAttribute("type")).toBe("password");
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(expectedCopy("ssh.advancedOptions"), "i"),
    }),
  );
  const download = screen.getByRole("group", {
    name: expectedCopy("ssh.assetInstallMode"),
  });
  expect(within(download).getByRole("button", { pressed: true })).toBeTruthy();
  expect(within(download).getByRole("button", { pressed: false })).toBeTruthy();
});

it.each([
  {
    kind: "ssh",
    sshAuthMethod: "privateKey",
    label: expectedCopy("ssh.privateKeyPassphrase"),
  },
  {
    kind: "server",
    sshAuthMethod: "password",
    label: expectedCopy("server.token"),
  },
] as const)(
  "$kind passphrase field can be shown and hidden and is label-associated",
  ({ kind, sshAuthMethod, label }) => {
    renderRemoteConnectionFields("en-US", { kind, sshAuthMethod });
    const input = screen.getByLabelText(label);
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("ssh.showPassword") }));
    expect(input.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("ssh.hidePassword") }));
    expect(input.getAttribute("type")).toBe("password");
  },
);

it("the Docker container list can be picked from the search box with arrow keys and Enter", async () => {
  const setDockerContainer = vi.fn();
  renderRemoteConnectionFields("en-US", {
    kind: "docker",
    dockerContainer: "alpha",
    dockerAvailable: true,
    dockerContainers: ["alpha", "beta"].map((name) => ({
      id: name,
      name,
      image: "ubuntu",
      state: "running",
      status: "Up",
    })),
    setDockerContainer,
  });
  fireEvent.click(screen.getByTestId("docker-container-select"));
  const search = await screen.findByRole("combobox");
  await waitFor(() => expect(document.activeElement).toBe(search));
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(setDockerContainer).toHaveBeenCalledWith("beta");
});
