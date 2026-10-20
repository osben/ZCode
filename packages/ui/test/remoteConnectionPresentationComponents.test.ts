// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { RemoteConnectionStatusTag } from "@/remote-connection/RemoteConnectionTags.js";
import { RemoteConnectionNavigationDot } from "@/remote-connection/RemoteConnectionNavigationDot.js";
import { RemoteTaskDeviceLabel } from "@/remote-connection/RemoteTaskDeviceLabel.js";
import { RemoteProjectConnectionDetails } from "@/WorkspaceSidebar/RemoteProjectConnectionDetails.js";
import { RemoteConnectionConnectingStep } from "@/remote-connection/RemoteConnectionConnectingStep.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import en from "@/i18n/locales/en-US.js";
import { expectedCopy } from "./helpers/uiCopy.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        Object.entries(values ?? {}).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          en[id] ?? id,
        ),
    },
  }),
}));
afterEach(cleanup);

it("recovery tag uses short phrases and separates state; details keep the full recovery note", () => {
  const presentation = resolveRemoteConnectionPresentation({
    state: "retrying",
    recoveryAttempt: 2,
    recoveryLimit: 3,
    target: { kind: "docker", container: "dev" },
  });
  const { container } = render(
    createElement(RemoteProjectConnectionDetails, {
      tab: {
        id: "project",
        kind: "workspace",
        label: "Project",
        workspacePath: "/srv/project",
        remoteTarget: { kind: "docker", container: "dev" },
      },
      deviceName: "Dev",
      presentation,
    }),
  );
  expect(container.querySelector("[data-remote-connection-status]")?.textContent).toBe(
    `${expectedCopy("workspaceSidebar.connecting")} · ${expectedCopy("workspaceSidebar.recoveringAutomaticShort", { attempt: 2, limit: 3 })}`,
  );
  expect(
    screen.getByText(
      expectedCopy("workspaceSidebar.recoveringAutomaticAttempt", { attempt: 2, limit: 3 }),
    ),
  ).toBeTruthy();
  expect(screen.getByText("Docker · dev")).toBeTruthy();
});

it("status tag and detail card show attention needed and the update direction", () => {
  const presentation = resolveRemoteConnectionPresentation({
    state: "needs-upgrade",
    upgradeTarget: "controller",
  });
  const { container } = render(
    createElement(RemoteProjectConnectionDetails, {
      tab: { id: "project", kind: "workspace", label: "Project", workspacePath: "/srv/project" },
      deviceName: "Dev",
      presentation,
    }),
  );
  expect(screen.getByText(expectedCopy("remote.status.pending"), { exact: false })).toBeTruthy();
  expect(screen.getByText(expectedCopy("remote.status.needsUpdate"))).toBeTruthy();
  expect(container.querySelector('[data-remote-connection-status="pending"]')?.className).toContain(
    "text-warning-surface-foreground",
  );
});

it("navigation dot reads the model in-progress color; recovery progress stays visible text", () => {
  const presentation = resolveRemoteConnectionPresentation({
    state: "retrying",
    recoveryAttempt: 2,
    recoveryLimit: 3,
  });
  const { container } = render(
    createElement(
      "div",
      null,
      createElement(RemoteConnectionNavigationDot, { presentation }),
      createElement(RemoteConnectionStatusTag, { presentation }),
    ),
  );
  expect(
    screen.getByText(
      expectedCopy("workspaceSidebar.recoveringAutomaticShort", { attempt: 2, limit: 3 }),
    ),
  ).toBeTruthy();
  expect(
    container.querySelector('[data-remote-navigation-status="connecting"]')?.className,
  ).toContain("progress-surface-foreground");
});

it("task-row device label reads the install gate from the same service snapshot", async () => {
  const emitter = new Emitter();
  const management = {
    getSnapshot: async () => ({
      servers: [{ sourceServerId: "device", displayName: "Dev", installState: "installed" }],
      profiles: [
        {
          profileId: "profile",
          sourceServerId: "device",
          target: { kind: "docker", container: "dev" },
        },
      ],
      states: [{ profileId: "profile", state: "needs-install", updatedAt: 1 }],
    }),
    onDidChangeState: emitter.event,
  };
  render(
    createElement(ServiceProvider, {
      services: { sourceServerManagementService: management } as never,
      children: createElement(RemoteTaskDeviceLabel, {
        task: { workspacePath: "/srv", sourceServerId: "device", serverDisplayName: "Dev" },
      }),
    }),
  );
  expect(await screen.findByText(expectedCopy("remote.status.needsInstall"))).toBeTruthy();
});

it("wizard shows the download-failure title by category and only offers the switch action for local downloads", () => {
  const onRetry = vi.fn();
  const target = {
    kind: "ssh" as const,
    host: "dev",
    username: "user",
    assetInstallMode: "remote-download" as const,
  };
  const child = createElement(RemoteConnectionConnectingStep, {
    kind: "ssh",
    target,
    loading: false,
    logs: [],
    errorMessage: "download failed",
    errorCode: "remote-download-failed",
    onBack: vi.fn(),
    onRetry,
    onUseRemoteDownload: vi.fn(),
  });
  render(createElement(PlatformProvider, { platform: {} as never, children: child }));
  expect(screen.getByText(expectedCopy("remote.error.downloadFailed"))).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: expectedCopy("remote.useRemoteDownload") }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: expectedCopy("remote.action.retry") }));
  expect(onRetry).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "credentials shown while connecting toggle visibility without submitting: passphrase=%s",
  (passphrase) => {
    const onSubmit = vi.fn();
    const child = createElement(RemoteConnectionConnectingStep, {
      kind: "ssh",
      errorMessage: "",
      loading: false,
      logs: [],
      onBack: vi.fn(),
      onRetry: vi.fn(),
      credentials: { value: "secret", passphrase, onChange: vi.fn(), onSubmit },
    });
    render(createElement(PlatformProvider, { platform: {} as never, children: child }));
    const input = screen.getByLabelText(
      passphrase ? expectedCopy("ssh.privateKeyPassphrase") : expectedCopy("ssh.password"),
    );
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("ssh.showPassword") }));
    expect(input.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("ssh.hidePassword") }));
    expect(input.getAttribute("type")).toBe("password");
    expect(onSubmit).not.toHaveBeenCalled();
  },
);
