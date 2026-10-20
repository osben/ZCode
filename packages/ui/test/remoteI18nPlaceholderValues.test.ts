// @vitest-environment jsdom
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import enUS from "@/i18n/locales/en-US.js";
import { SourceServerManagementPanel } from "@/settings/SourceServerManagementPanel.js";

/**
 * §9 gate 1: every placeholder-bearing i18n key reached in this round must have a
 * "renders concrete values" assertion, guarding against {time}-style regressions.
 * The mock replicates IntlProvider.createIntl's real semantics (real en-US messages +
 * {key} replaceAll interpolation) and asserts the rendered result contains the concrete
 * values and leaves no raw `{placeholder}` literals behind.
 */
function formatEnMessage({ id }: { id: string }, values?: Record<string, string | number>): string {
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
    intl: { formatMessage: formatEnMessage },
    locale: "en-US",
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
      // §9 gate 5: project count dedupes by workspaceKey — same identity merges (A/B),
      // missing identity falls back to path merging (C/D), same path with a different identity
      // does not merge (E) → 3 projects in total.
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
      screen.queryByText(enUS["settings.source.showAllProjects"].replace("{count}", "3")),
    ).toBeNull();
    const connection = container.querySelector("[data-device-connection]")?.textContent ?? "";
    expect(connection).toContain("v3.8.1");
    expect(connection).toContain(
      enUS["settings.source.lastOnline"].replace(
        "{time}",
        enUS["common.minutesAgo"].replace("{count}", "16"),
      ),
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
      await screen.findByText(enUS["settings.source.projectCount"].replace("{count}", "0")),
    ).toBeTruthy();
    // With a single connection "current / default" carries no meaning, so it is not shown.
    expect(screen.queryByText(enUS["settings.source.currentProfile"])).toBeNull();
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
        enUS["settings.source.updateAvailableVersion"].replace("{version}", "3.8.2"),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        enUS["settings.source.versionDetails"]
          .replace("{current}", "3.8.1")
          .replace("{minimum}", "3.7.0"),
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
