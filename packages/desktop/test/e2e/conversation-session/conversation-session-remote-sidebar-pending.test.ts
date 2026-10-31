import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { ServiceChannels, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData, readSettings } from "#e2e/helpers/desktop-app";
import { waitForRemoteDeviceLocated } from "#e2e/helpers/remote-project-actions";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import { prepareSourceServerUpdateArchive } from "#e2e/helpers/source-server-update-fixture";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_REMOTE_SIDEBAR_PENDING";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-sidebar-pending",
);
const run = promisify(execFile);

/** Read the remote's current release read-only via docker exec, without occupying the SSH connection under test. */
async function setAppearance(locale: "en-US" | "zh-CN", theme: "light" | "dark") {
  await browser.execute(
    (lang, appearance) => {
      const actions = (
        window as Window & {
          __testActions?: {
            setLocale(value: "zh-CN" | "en-US"): void;
            setTheme(value: string): void;
          };
        }
      ).__testActions;
      if (!actions) throw new Error("Missing appearance actions");
      actions.setLocale(lang);
      actions.setTheme(appearance);
    },
    locale,
    theme,
  );
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
}

async function readRemoteCurrentSha(): Promise<string> {
  const container = process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
  if (!container) throw new Error(`${CASE_MARKER}: missing ZCODE_E2E_SSH_CONTAINER`);
  const { stdout } = await run(
    "docker",
    [
      "exec",
      "-u",
      process.env.ZCODE_E2E_SSH_USERNAME?.trim() || "dev",
      container,
      "bash",
      "-lc",
      'grep -o \'"archiveSha256": *"[0-9a-f]*"\' "$HOME/.zcode/server/current.json" | grep -o "[0-9a-f]\\{64\\}"',
    ],
    { timeout: 30_000 },
  );
  return stdout.trim();
}

describe(`${CASE_MARKER}: pending devices show the specific reason in the project row and details`, () => {
  afterEach(async () => {
    await browser.saveScreenshot(resolve(artifactDir, "last-state.png"));
  });
  after(async () => {
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RDUX-SIDEBAR-PENDING needs-upgrade shows “Update required”; the details entry locates the device card in settings and does not update automatically", async function () {
    this.timeout(15 * 60_000);
    await mkdir(artifactDir, { recursive: true });
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const tab = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: config.workspacePaths[0]!,
    });
    const identity = tab.workspaceIdentity!;
    const sourceId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: remote project is missing its Source identity`);
    const profileId = (await readSettings()).connectionProfiles?.find(
      (profile) => profile.sourceServerId === sourceId,
    )?.profileId;
    if (!profileId) throw new Error(`${CASE_MARKER}: device route not found`);

    // Repack this round's release so the installed remote SHA differs from the desktop's expectation, reproducing a startup reconnect stuck at needs-upgrade.
    const shaBefore = await readRemoteCurrentSha();
    const repack = await prepareSourceServerUpdateArchive(shaBefore, CASE_MARKER);
    expect(repack.newSha).not.toBe(shaBefore);

    await installHandoffRpcProbe();
    await callHandoffHost(ServiceChannels.SourceServerManagement, "disconnectSource", [sourceId]);
    // Connect through the Host directly, bypassing the wizard; the wizard starts the update automatically, so the pending device could not be observed.
    await callHandoffHost(ServiceChannels.SourceServerManagement, "connectProfile", [
      profileId,
    ]).catch(() => undefined);

    await selectTaskOrganizeMode(["Project"]);
    const row = $(`[data-project-workspace-identity=${JSON.stringify(identity)}]`);
    const status = row.$('[data-testid="project-status-label"]');
    await browser.waitUntil(
      async () => (await status.isExisting()) && /^Update required$/u.test(await status.getText()),
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: project row did not show “Update required”` },
    );
    expect(await status.getAttribute("class")).toContain("text-warning-surface-foreground");
    expect(await row.$('[data-remote-state-icon="cloud-alert"]').isExisting()).toBe(true);
    // The Host projection once dropped upgradeTarget, so the details entry wrongly showed "Update remote device" on an outdated desktop; this locks in that the projection carries the field.
    const directory = await callHandoffHost<{ hosts: { id: string; upgradeTarget?: string }[] }>(
      ServiceChannels.RemoteProjects,
      "readDirectory",
    );
    expect(
      directory.hosts.find((host) => host.id === `remote:server:${sourceId}`)?.upgradeTarget,
    ).toBe("server");

    const details = $('[data-testid="remote-identity-details"]');
    for (const locale of ["zh-CN", "en-US"] as const) {
      for (const theme of ["light", "dark"] as const) {
        await setAppearance(locale, theme);
        // The status is key inline information and must display fully in a narrow sidebar; the project and device names yield the space.
        expect(
          await browser.execute(
            (el) => el.scrollWidth <= el.clientWidth,
            await status.getElement(),
          ),
        ).toBe(true);
        const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
        await browser.action("pointer").move(outside).perform();
        await details.waitForDisplayed({ reverse: true });
        await row.$('[data-testid="virtual-project-toggle"]').moveTo();
        await details.waitForDisplayed();
        await browser.saveScreenshot(resolve(artifactDir, `pending-${locale}-${theme}.png`));
      }
    }
    await setAppearance("en-US", "dark");
    const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
    await browser.action("pointer").move(outside).perform();
    await details.waitForDisplayed({ reverse: true });
    await row.$('[data-testid="virtual-project-toggle"]').moveTo();
    await details.waitForDisplayed();
    const detailsText = await details.getText();
    expect(detailsText).toMatch(/Update required/u);
    expect(detailsText).not.toMatch(/Needs attention/u);
    const buttons = await details.$$("button");
    expect(buttons).toHaveLength(1);
    const entry = details.$('[data-testid="remote-identity-device-settings"]');
    expect(await entry.getText()).toMatch(/Update remote device/u);
    await browser.saveScreenshot(resolve(artifactDir, "pending-details.png"));

    await entry.click();
    await details.waitForDisplayed({ reverse: true });
    const card = $(`[data-source-server-card="${sourceId}"]`);
    await card.waitForDisplayed({ timeout: 15_000 });
    // RDUX-13: after locating, only the target device row expands; focus stays on the device name button and remains highlighted.
    await waitForRemoteDeviceLocated(sourceId, CASE_MARKER);
    expect(await card.getText()).toMatch(/Update remote device/u);
    await browser.saveScreenshot(resolve(artifactDir, "device-settings.png"));
    // The entry only locates the device; it must not perform the update on the user's behalf.
    expect(await readRemoteCurrentSha()).toBe(shaBefore);
  });
});
