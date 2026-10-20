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

it("恢复标签使用短句并分隔状态，详情保留完整恢复说明", () => {
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

it("状态标签与详情卡显示需要处理及更新方向", () => {
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

it("导航点读取模型的进行中色，恢复进度是可见文字", () => {
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

it("任务行设备标签读取同一服务快照的安装门禁", async () => {
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

it("向导按下载失败分类展示标题，只在本地下载时提供切换操作", () => {
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

it.each([false, true])("连接中补凭据可显隐且不触发提交：口令=%s", (passphrase) => {
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
});
