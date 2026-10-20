// @vitest-environment jsdom
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import enUS from "@/i18n/locales/en-US.js";
import { SourceServerManagementPanel } from "@/settings/SourceServerManagementPanel.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

/**
 * §9 门禁 1：本轮触达的带占位符 i18n key 必须有「渲染含实值」断言，防 {time} 类回归。
 * mock 复刻 IntlProvider.createIntl 的真实语义（真实 en-US 消息 + {key} replaceAll 插值），
 * 断言渲染结果含具体值且不残留任何 `{placeholder}` 字面量。
 */
function formatTestMessage(
  { id }: { id: string },
  values?: Record<string, string | number>,
): string {
  let message = enUS[id] ?? id;
  if (values) {
    for (const [key, value] of Object.entries(values)) {
      message = message.replaceAll(`{${key}}`, String(value));
    }
  }
  return message;
}

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: formatTestMessage },
    locale: TEST_LOCALE,
  }),
}));

vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => vi.fn(async () => true),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";

function baseSnapshot(
  overrides: Partial<SourceServerManagementSnapshot>,
): SourceServerManagementSnapshot {
  return {
    generation: 1,
    profiles: [
      {
        profileId,
        transport: "docker",
        target: { kind: "docker", container: "dev" },
        sourceServerId,
        createdAt: 1,
      },
    ],
    servers: [
      {
        sourceServerId,
        displayName: "devbox",
        installState: "installed",
        lastSeenVersion: "3.8.1",
      },
    ],
    workspaceHistory: [],
    states: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
    ...overrides,
  } as SourceServerManagementSnapshot;
}

function renderPanel(snapshot: SourceServerManagementSnapshot) {
  return render(
    createElement(SourceServerManagementPanel, {
      management: {
        getSnapshot: vi.fn(async () => snapshot),
        onDidChangeState: new Emitter().event,
        onDidChangeDirectory: new Emitter().event,
      } as never,
    }),
  );
}

function expectNoRawPlaceholders(container: HTMLElement) {
  expect(container.textContent ?? "").not.toMatch(/\{\w+\}/u);
}

describe("SourceServerManagementPanel placeholder values", () => {
  it("renders version, offline relative time and at most three deduplicated project names", async () => {
    const identityA = `remote:server:${sourceServerId}:/srv/a`;
    const identityE = `remote:server:${sourceServerId}:/srv/c-alt`;
    const snapshot = baseSnapshot({
      servers: [
        {
          sourceServerId,
          displayName: "devbox",
          installState: "installed",
          lastSeenVersion: "3.8.1",
          lastOnlineAt: Date.now() - 16.5 * 60_000,
        },
      ],
      // §9 门禁 5：项目数按 workspaceKey 去重——同 identity 合并（A/B）、
      // 缺 identity 按路径回退合并（C/D）、同路径不同 identity 不合并（E）→ 共 3 个项目。
      workspaceHistory: [
        {
          workspacePath: "/srv/a",
          workspaceIdentity: identityA,
          profileId,
          sourceServerId,
          lastOpenedAt: 1,
        },
        {
          workspacePath: "/srv/b",
          workspaceIdentity: identityA,
          profileId,
          sourceServerId,
          lastOpenedAt: 2,
        },
        {
          workspacePath: "/srv/c",
          profileId,
          sourceServerId,
          lastOpenedAt: 3,
        },
        {
          workspacePath: "/srv/c",
          profileId,
          sourceServerId,
          lastOpenedAt: 4,
        },
        {
          workspacePath: "/srv/c",
          workspaceIdentity: identityE,
          profileId,
          sourceServerId,
          lastOpenedAt: 5,
        },
      ],
    });

    const { container } = renderPanel(snapshot);

    expect(await screen.findByRole("button", { name: "b" })).toBeTruthy();
    expect(container.querySelectorAll("[data-device-project]")).toHaveLength(3);
    expect(screen.queryByText("+2")).toBeNull();
    expect(
      screen.queryByText(expectedCopy("settings.source.showAllProjects", { count: 3 })),
    ).toBeNull();
    const connection = container.querySelector("[data-device-connection]")?.textContent ?? "";
    expect(connection).toContain("v3.8.1");
    expect(connection).toContain(
      expectedCopy("settings.source.lastOnline", {
        time: expectedCopy("common.minutesAgo", { count: 16 }),
      }),
    );
    expectNoRawPlaceholders(container);
  });

  it("renders a single connection and empty project count without raw placeholders", async () => {
    const snapshot = baseSnapshot({
      states: [
        {
          profileId,
          sourceServerId,
          state: "online",
          updateAvailability: "none",
          updatedAt: 10,
        },
      ],
    });

    const { container } = renderPanel(snapshot);

    expect(
      await screen.findByText(expectedCopy("settings.source.projectCount", { count: 0 })),
    ).toBeTruthy();
    // 单条连接时“当前 / 默认”没有区分意义，不显示。
    expect(screen.queryByText(expectedCopy("settings.source.currentProfile"))).toBeNull();
    expectNoRawPlaceholders(container);
  });

  it("interpolates the available version banner and the current/minimum details", async () => {
    const snapshot = baseSnapshot({
      states: [
        {
          profileId,
          sourceServerId,
          state: "online",
          updateAvailability: "available",
          currentVersion: "3.8.1",
          availableVersion: "3.8.2",
          minimumVersion: "3.7.0",
          updatedAt: 10,
        },
      ],
    });

    const { container } = renderPanel(snapshot);

    expect(
      await screen.findByText(
        expectedCopy("settings.source.updateAvailableVersion", { version: "3.8.2" }),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        expectedCopy("settings.source.versionDetails", { current: "3.8.1", minimum: "3.7.0" }),
      ),
    ).toBeTruthy();
    expectNoRawPlaceholders(container);
  });
});

describe("remote recovery projection payload", () => {
  it("passes attempt and limit in the recovery projection payload", async () => {
    const presentation = resolveRemoteConnectionPresentation({
      state: "retrying",
      recoveryAttempt: 2,
      recoveryLimit: 3,
    });
    expect(presentation.recovery).toEqual({
      messageId: "workspaceSidebar.recoveringAutomaticAttempt",
      shortMessageId: "workspaceSidebar.recoveringAutomaticShort",
      values: { attempt: 2, limit: 3 },
    });
  });
});
