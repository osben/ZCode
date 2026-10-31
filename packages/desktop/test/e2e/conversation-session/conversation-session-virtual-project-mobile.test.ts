// Both the unified runner and the legacy manual entry use an isolated HOME; a safe fixture must not be rejected just because the runId prefix differs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openMobilePairingPage } from "../helpers/mobile-pairing.js";
import { selectNativeProjectDirectories } from "../helpers/project-sidebar.js";
import { ServiceChannels } from "@zcode/shared";
import {
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, basename } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  seedLegacyProviderTasks,
  LEGACY_PINNED_TASK_IDS,
  CURRENT_IMPORTED_TASK_ID,
} from "#e2e/helpers/project-upgrade-order-fixture";
import { chromium, type Browser, type Page } from "playwright-core";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";
import { clearAppData, waitForWorkspaceApp, DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import { readHostProcesses } from "../helpers/ssh-remote-p0.js";
import { closeResourceManagerWindow } from "../helpers/resource-manager.js";

import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";

const SAVED_REMOTE_HOST = "remote:server:e2e-mobile-saved-device";

type VirtualProjectTestWindow = Window & {
  __testActions?: { getTheme(): string; setTheme(theme: string): void };
  __zcodeTabStoreE2E?: {
    getState(): {
      tabs: unknown[];
      activeWorkspacePath: string | null;
      activeWorkspaceIdentity?: string | null;
    };
  };
  __zcodeSessionStoreE2E?: {
    getState(): {
      getWorkspaceState(
        path: string,
        identity?: string,
      ): { draftProjectId?: string | null; activeTaskId: string | null };
    };
  };
  __vp13RestoreClipboard?: () => void;
};

/** A real touch long-press triggers the legacy ContextMenu; do not substitute a desktop right-click for the mobile interaction. */
async function longPressGroup(page: Page, title: string) {
  const header = page.locator(`[data-task-group-title="${title}"] [data-grouped-group-header-id]`);
  // CDP coordinate input has no Playwright actionability checks, so first wait for the target to settle after the collapse toggle and accept touches.
  await header.tap({ trial: true });
  const box = await header.boundingBox();
  if (!box) throw new Error("group header missing");
  const cdp = await page.context().newCDPSession(page);
  // Read-only record of the real touch hit target and cancel events, to tell coordinate problems apart from the product handler cancelling the long-press.
  // Playwright serializes functions directly; a string script avoids the bundler inserting invisible __name references into nested callbacks.
  await page.evaluate(`(() => {
    const probe = { events: [], dispose: () => {} };
    const types = ["pointerdown", "pointermove", "pointerup", "pointercancel", "contextmenu", "touchstart", "touchend"];
    const listen = event => {
      const target = event.target instanceof Element ? event.target.outerHTML.slice(0, 600) : null;
      queueMicrotask(() => probe.events.push({ type: event.type, prevented: event.defaultPrevented, target }));
    };
    for (const type of types) document.addEventListener(type, listen, true);
    probe.dispose = () => { for (const type of types) document.removeEventListener(type, listen, true); };
    window.__vp13TouchProbe = probe;
  })()`);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + 80, y: box.y + box.height / 2 }],
    });
    await page.locator('[data-testid="task-group-rename"]').waitFor();
  } catch (error) {
    const diagnostic = await page.evaluate(
      () =>
        (window as Window & { __vp13TouchProbe?: { events: unknown[] } }).__vp13TouchProbe?.events,
    );
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP13-touch-events.json"),
      JSON.stringify({ box, diagnostic }, null, 2),
    );
    throw error;
  } finally {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.evaluate(() => {
      const target = window as Window & { __vp13TouchProbe?: { dispose(): void } };
      target.__vp13TouchProbe?.dispose();
      delete target.__vp13TouchProbe;
    });
    await cdp.detach();
  }
}

// The wdio fixture auto-starts this repo's Web app on :5173 with VITE_ZCODE_E2E_STORE_BRIDGE=1 (the port must be free); the desktop URL points to the same address.
describe("虚拟项目手机 shared-host 导航", () => {
  after(async () => {
    await restoreHandoffProbes();
    await clearAppData();
  });
  it("VP13：手机实际首页复用项目列表，新目录草稿交接不增加桌面 tab", async function () {
    this.timeout(180_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    const testHome = process.env.ZCODE_E2E_HOME_DIR!;
    if (
      !testHome ||
      ![".e2e-home-", "zcode-virtual-project-e2e-"].some((prefix) =>
        basename(testHome).startsWith(prefix),
      )
    )
      throw new Error("隔离 HOME required");
    const cwd = join(testHome, "E2E_VP13_UNOPENED");
    const additionalRoot = join(testHome, "E2E_VP13_ADDITIONAL");
    await mkdir(cwd, { recursive: true });
    await mkdir(additionalRoot, { recursive: true });
    await promisify(execFile)("git", ["init", "--initial-branch=main", cwd]);
    await writeFile(join(cwd, "E2E_VP13_FILES.txt"), "file-only target");
    // Prepare the migrated data before registering the project directory, so a direct write that bypasses events does not leave the Controller holding a stale list.
    const db = new DatabaseSync(join(testHome, ".zcode/v2/tasks-index.sqlite"));
    try {
      seedLegacyProviderTasks(db, cwd);
      db.prepare(`UPDATE tasks SET host_id='local',root_path=workspace_path,
        cli_title=title,cli_created_at=created_at,cli_updated_at=updated_at,cli_deleted=0
        WHERE task_id IN (?,?,?)`).run(...LEGACY_PINNED_TASK_IDS, CURRENT_IMPORTED_TASK_ID);
    } finally {
      db.close();
    }
    await openLocalProjectEditor();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_VP13_PROJECT");
    await chooseProjectRoot(cwd);
    await chooseProjectRoot(additionalRoot);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    const project = $('[data-project-name="E2E_VP13_PROJECT"]');
    await project.waitForDisplayed();
    const projectId = await project.getAttribute("data-project-id");
    expect(
      await project
        .$('[data-testid="virtual-project-toggle"]')
        .getAttribute("aria-roledescription"),
    ).toBe("sortable");
    // Only register the existing device without dialing; the phone should read the existing Host without needing Source management permission.
    await installHandoffRpcProbe();
    await callHandoffHost(ServiceChannels.RemoteProjects, "saveHost", [
      {
        id: SAVED_REMOTE_HOST,
        target: { kind: "ssh", host: "saved-device.example.test", username: "dev" },
      },
    ]);
    const hostCount = (await readHostProcesses()).length;
    // Close the inspector after collecting evidence: a continuous 800ms child-process query would time out during CLI startup and reclaim the runtime.
    await closeResourceManagerWindow();
    const desktopTabs = await browser.execute(
      () => (window as VirtualProjectTestWindow).__zcodeTabStoreE2E?.getState().tabs.length,
    );
    let receivePair!: (url: string) => void;
    const pairing = new Promise<string>((resolve) => {
      receivePair = resolve;
    });
    // Pairing material passes only through the in-memory loopback receiver, so no password lands in the WDIO result log.
    const pairReceiver = createServer(async (request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.method === "OPTIONS") {
        response.end();
        return;
      }
      let value = "";
      for await (const chunk of request) value += String(chunk);
      receivePair(value);
      response.end();
    });
    pairReceiver.listen(0, "127.0.0.1");
    await once(pairReceiver, "listening");
    const address = pairReceiver.address();
    if (!address || typeof address === "string") throw new Error("pair receiver failed");
    let mobileBrowser: Browser | undefined;
    let mobilePage: Page | undefined;
    // A page reload clears the in-window touch probe; the test process keeps the navigation source so a startup/HMR failure is not misread as a menu bug.
    const navigationDiagnostics: unknown[] = [];
    const publicUrl = (value: string) => {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "<script>";
      }
    };
    let stage = "pairing";
    const enterStage = (next: string) => {
      stage = next;
      process.stderr.write(`VP13 stage: ${stage}\n`);
    };
    try {
      await browser.execute((port) => {
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        (window as VirtualProjectTestWindow).__vp13RestoreClipboard = () => {
          navigator.clipboard.writeText = original;
        };
        navigator.clipboard.writeText = async (text) => {
          await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: text });
        };
      }, address.port);
      await $(
        'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
      ).click();
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                '[data-testid="web-remote-control-dialog-scroll"] button',
              ),
            ).find(
              (node) => /^(复制链接|Copy link)$/.test(node.innerText.trim()) && !node.disabled,
            );
            button?.click();
            return Boolean(button);
          }),
        { timeout: 60_000, timeoutMsg: "VP13 pairing link unavailable" },
      );
      const pairUrl = await pairing;
      const target = new URL(pairUrl);
      if (target.origin !== "http://127.0.0.1:5173")
        throw new Error("VP13 requires current local Web build");
      // A local capture proxy may issue Chrome an untrusted certificate; allow the test browser to connect to the relay directly.
      mobileBrowser = await chromium.launch({
        ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
          ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
          : { channel: "chrome" }),
        headless: true,
        args: process.env.ZCODE_E2E_BROWSER_NO_PROXY === "1" ? ["--no-proxy-server"] : [],
      });
      const context = await mobileBrowser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "en-US",
      });
      // Reason: the legacy case depended on a real sign-in state, and a Personal-only startup stops at the pairing gate.
      // Only the external account and relay are replaced; Main, Host, the phone renderer and app RPC still run the real path.
      // The relay is reached directly through the Web proxy started by the fixture; the test no longer adds its own HTTP/WS forwarding.
      await context.addInitScript((credentials) => {
        if (sessionStorage.getItem("vp13-fixture-credentials-seeded")) return;
        sessionStorage.setItem("vp13-fixture-credentials-seeded", "1");
        for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
      }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
      const page = await context.newPage();
      mobilePage = page;
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Page.enable");
      cdp.on("Page.frameRequestedNavigation", ({ reason, url }) =>
        navigationDiagnostics.push({
          at: Date.now(),
          stage,
          kind: "navigation",
          reason,
          url: publicUrl(url),
        }),
      );
      cdp.on("Network.requestWillBeSent", ({ type, request, initiator }) => {
        if (type !== "Document") return;
        navigationDiagnostics.push({
          at: Date.now(),
          stage,
          kind: "document",
          url: publicUrl(request.url),
          initiator: initiator.type,
          stack: initiator.stack?.callFrames.slice(0, 8).map((frame) => ({
            functionName: frame.functionName,
            url: frame.url ? publicUrl(frame.url) : "",
            line: frame.lineNumber,
          })),
        });
      });
      cdp.on("Network.webSocketFrameReceived", ({ response }) => {
        if (response.opcode !== 1) return;
        try {
          const frame = JSON.parse(response.payloadData) as { type?: string; path?: string };
          if (frame.type === "full-reload" || frame.type === "update")
            navigationDiagnostics.push({
              at: Date.now(),
              stage,
              kind: "vite",
              type: frame.type,
              path: frame.path,
            });
        } catch {
          // Other relay frames are not the target of this diagnostic; their content and pairing material are not stored.
        }
      });
      cdp.on("Network.webSocketCreated", ({ url }) =>
        process.stderr.write(`VP13 CDP websocket: ${new URL(url).origin}\n`),
      );
      cdp.on("Network.webSocketFrameError", ({ errorMessage }) =>
        process.stderr.write(
          `VP13 CDP socket error: ${errorMessage.match(/net::[A-Z_]+/)?.[0] ?? "handshake-error"}\n`,
        ),
      );
      page.on("websocket", (socket) => {
        const origin = new URL(socket.url()).origin;
        process.stderr.write(`VP13 websocket created: ${origin}\n`);
        socket.on("socketerror", () => process.stderr.write(`VP13 websocket error: ${origin}\n`));
        socket.on("close", () => process.stderr.write(`VP13 websocket closed: ${origin}\n`));
      });
      // Record only the error category; do not record pairing material from the URL or query.
      page.on("pageerror", (error) =>
        process.stderr.write(`VP13 page error: ${error.name}: ${error.message.split("http")[0]}\n`),
      );
      enterStage("mobile relay admission");
      await openMobilePairingPage(page, pairUrl, {
        artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR!,
        caseMarker: "VP13",
        phase: "file-navigation",
        readySelector: '[data-project-name="E2E_VP13_PROJECT"]',
      });
      const mobileProject = page.locator('[data-project-name="E2E_VP13_PROJECT"]');
      await mobileProject.waitFor({ timeout: 60_000 });
      enterStage("legacy backend visibility and current import actions");
      for (const id of LEGACY_PINNED_TASK_IDS)
        expect(await page.getByTestId(`task-item-${id}`).count()).toBe(0);
      const imported = page.getByTestId(`task-item-${CURRENT_IMPORTED_TASK_ID}`);
      await imported.waitFor();
      await imported.getByRole("button", { name: /Unpin task/ }).tap();
      await page
        .getByTestId("conversation-section")
        .getByTestId(`task-item-${CURRENT_IMPORTED_TASK_ID}`)
        .waitFor();
      await imported.locator('button[data-testid^="task-archive-"]').tap();
      await page
        .locator(`[data-archive-confirming-task-id="${CURRENT_IMPORTED_TASK_ID}"]`)
        .waitFor();
      await imported.locator('button[data-testid^="task-archive-"]').tap();
      await imported.waitFor({ state: "detached" });
      enterStage("VP24/31 mobile project actions");
      const toggleAll = page.getByTestId("virtual-project-toggle-all");
      await toggleAll.tap();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-testid="virtual-project-toggle"]')].every(
          (node) => node.getAttribute("aria-expanded") === "false",
        ),
      );
      await toggleAll.tap();
      await page.waitForFunction(
        () =>
          document
            .querySelector(
              '[data-project-name="E2E_VP13_PROJECT"] [data-testid="virtual-project-toggle"]',
            )
            ?.getAttribute("aria-expanded") === "true",
      );
      const edges = await page.evaluate(() =>
        ["virtual-project-add", "virtual-project-new-task", "virtual-project-create-task"].map(
          (id) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().right,
        ),
      );
      expect(Math.abs(edges[0]! - edges[2]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(edges[1]! - edges[2]!)).toBeLessThanOrEqual(1);
      enterStage("GRP09 shared-host group writes");
      const group = await callHandoffHost<{ id: string }>(ServiceChannels.TaskGroups, "save", [
        { title: "E2E_MOBILE_GROUP", color: "blue" },
      ]);
      await page.locator('[data-testid="sidebar-view-menu"]').click();
      await page.locator('[data-testid="sidebar-view-grouped"]').click();
      await page.locator('[data-testid="sidebar-view-grouped"]').waitFor({ state: "detached" });
      const mobileGroup = page.locator('[data-task-group-title="E2E_MOBILE_GROUP"]');
      await mobileGroup.waitFor();
      expect(await mobileGroup.locator("svg.lucide-hash").count()).toBe(1);
      await mobileGroup.locator('[data-testid="task-group-color-trigger"]').tap();
      await page.locator('[data-testid="task-group-color-purple"]').tap();
      await mobileGroup.locator("[data-grouped-group-header-id]").tap();
      expect(await mobileGroup.getAttribute("data-group-collapsed")).toBe("true");
      await mobileGroup.locator("[data-grouped-group-header-id]").tap();
      await longPressGroup(page, "E2E_MOBILE_GROUP");
      await page.locator('[data-testid="task-group-rename"]').click();
      await page.locator('[data-testid="task-group-title-input"]').fill("E2E_MOBILE_RENAMED");
      await page.locator('[data-testid="task-group-title-input"]').press("Enter");
      await browser.waitUntil(async () =>
        (
          await callHandoffHost<{ groups: Array<{ id: string; title: string }> }>(
            ServiceChannels.TaskGroups,
            "read",
          )
        ).groups.some((entry) => entry.id === group.id && entry.title === "E2E_MOBILE_RENAMED"),
      );
      for (const theme of ["zai-light", "zai-dark"]) {
        await page.evaluate(
          (theme) => (window as VirtualProjectTestWindow).__testActions!.setTheme(theme),
          theme,
        );
        await page.waitForFunction(
          (value) => document.documentElement.classList.contains(`theme-${value}`),
          theme,
        );
        // Focusing the phone input must not scroll the clipping container of the sliding panel, or the whole column moves left out of the viewport.
        const groupLayout = await page
          .locator('[data-task-group-title="E2E_MOBILE_RENAMED"]')
          .evaluate((row) => {
            const rect = row.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: innerWidth };
          });
        expect(groupLayout.left).toBeGreaterThanOrEqual(0);
        expect(groupLayout.right).toBeLessThanOrEqual(groupLayout.width);
        await page.screenshot({
          path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `task-groups-mobile-${theme}.png`),
        });
      }
      await longPressGroup(page, "E2E_MOBILE_RENAMED");
      await page.locator('[data-testid="task-group-ungroup"]').click();
      await browser.waitUntil(
        async () =>
          !(
            await callHandoffHost<{ groups: Array<{ id: string }> }>(
              ServiceChannels.TaskGroups,
              "read",
            )
          ).groups.some((entry) => entry.id === group.id),
      );
      await page.locator('[data-testid="sidebar-view-menu"]').click();
      await page.locator('[data-testid="sidebar-view-projects"]').click();
      enterStage("SBV06 mobile search and view");
      const toolbar = await page.evaluate(() => {
        const search = document
          .querySelector('[data-testid="sidebar-search-open"]')!
          .getBoundingClientRect();
        const filter = document
          .querySelector('[data-testid="sidebar-view-menu"]')!
          .getBoundingClientRect();
        return {
          searchHeight: search.height,
          filterHeight: filter.height,
          right: filter.right,
          width: innerWidth,
        };
      });
      expect(toolbar.searchHeight).toBe(24);
      expect(toolbar.filterHeight).toBe(24);
      expect(toolbar.right).toBeLessThanOrEqual(toolbar.width);
      // New sidebar interactions go through real touch events; the next action waits for the menu exit animation to finish.
      await page.getByTestId("sidebar-search-open").tap();
      await page.locator('[role="dialog"] [cmdk-input]').waitFor();
      await page.keyboard.press("Escape");
      await page.getByTestId("sidebar-view-menu").tap();
      expect(await page.getByRole("menuitemradio").count()).toBe(4);
      expect(
        await page.getByTestId("sidebar-view-projects").locator("svg.lucide-folder").isVisible(),
      ).toBe(true);
      expect(
        await page.getByTestId("sidebar-view-timeline").locator("svg.lucide-clock").isVisible(),
      ).toBe(true);
      await page.getByTestId("sidebar-view-timeline").tap();
      await page.getByRole("menu").waitFor({ state: "hidden" });
      expect(await page.getByTestId("project-section").count()).toBe(0);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("sidebar-view-menu").waitFor();
      expect(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem("zcode-project-sidebar-preferences") ?? "{}").view,
        ),
      ).toBe("timeline");
      await page.getByTestId("sidebar-view-menu").tap();
      await page.getByTestId("sidebar-view-projects").tap();
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await mobileProject.waitFor();
      enterStage("mobile project editor");
      // PCD03: first confirm the current state is a draft; creating from the home page should select the new project and return to chat.
      await mobileProject.getByTestId("virtual-project-create-task").tap();
      await page.locator('[data-mobile-page="chat"]').waitFor();
      await page.getByRole("button", { name: /Back to task home/ }).tap();
      await page.getByTestId("virtual-project-add").tap();
      await page.getByTestId("virtual-project-name").waitFor();
      await page.screenshot({
        path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP19-mobile-form.png"),
      });
      // The phone pickers use real touches and wait for the popover to close before starting the next selection.
      await page.getByTestId("virtual-project-device").tap();
      const savedDevice = page.locator(`[role="option"][data-device-id="${SAVED_REMOTE_HOST}"]`);
      await savedDevice.waitFor();
      expect(await savedDevice.textContent()).toMatch(/离线|Offline/);
      expect(
        await savedDevice.getByTestId("virtual-project-device-status").getAttribute("data-status"),
      ).toBe("offline");
      expect(await page.getByRole("option", { name: /Add remote device/ }).count()).toBe(0);
      await savedDevice.tap();
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      expect(await page.getByTestId("virtual-project-browse").textContent()).toMatch(
        /连接并选择文件夹|Connect and choose folder/,
      );
      expect(await page.getByTestId("virtual-project-existing").textContent()).toMatch(
        /添加到侧栏|Add to sidebar/,
      );
      expect(
        await page.evaluate(() => {
          const fields = ["name", "device", "existing", "browse"].map(
            (field) => document.querySelector(`[data-testid="virtual-project-${field}"]`)!,
          );
          return fields
            .slice(1)
            .every((field, index) =>
              Boolean(
                fields[index]!.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING,
              ),
            );
        }),
      ).toBe(true);
      await page.getByTestId("virtual-project-device").tap();
      await page.locator('[role="option"][data-device-id="local"]').tap();
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      enterStage("mobile directory selection");
      await page.getByTestId("virtual-project-name").fill("E2E_VP19_MOBILE_PROJECT");
      await page.getByTestId("virtual-project-browse").tap();
      const directoryPicker = page.getByTestId("virtual-project-directory-browser");
      await directoryPicker.locator("input").waitFor();
      await page.waitForFunction(() =>
        Boolean(
          document.querySelector<HTMLInputElement>(
            '[data-testid="virtual-project-directory-browser"] input',
          )?.value,
        ),
      );
      await directoryPicker.locator("input").fill(cwd);
      await directoryPicker.locator("input").press("Enter");
      await directoryPicker.getByRole("button", { name: /^(Choose folder)$/ }).tap();
      await page.screenshot({
        path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP19-mobile-editor.png"),
      });
      enterStage("mobile folder confirmation");
      await page.getByTestId("virtual-project-save").tap();
      await page.getByTestId("project-folder-trust-dialog").waitFor();
      expect(await page.getByTestId("project-folder-trust-path").allTextContents()).toEqual([cwd]);
      const beforeMobileCreate = await callHandoffHost<Array<{ name: string }>>(
        ServiceChannels.Project,
        "readProjects",
      );
      expect(beforeMobileCreate.some((item) => item.name === "E2E_VP19_MOBILE_PROJECT")).toBe(
        false,
      );
      await page.getByTestId("project-folder-trust-cancel").tap();
      await page.getByTestId("project-folder-trust-dialog").waitFor({ state: "hidden" });
      expect(await page.getByTestId("virtual-project-name").inputValue()).toBe(
        "E2E_VP19_MOBILE_PROJECT",
      );
      await page.getByTestId("virtual-project-save").tap();
      await page.getByTestId("project-folder-trust-dialog").waitFor();
      const mobileTheme = await page.evaluate(() =>
        (window as VirtualProjectTestWindow).__testActions!.getTheme(),
      );
      for (const theme of ["zai-light", "zai-dark"]) {
        await page.evaluate(
          (value) => (window as VirtualProjectTestWindow).__testActions!.setTheme(value),
          theme,
        );
        await page.waitForFunction(
          (value) => document.documentElement.classList.contains(`theme-${value}`),
          theme,
        );
        await page.waitForFunction(() => {
          const dialog = document.querySelector('[data-testid="project-folder-trust-dialog"]');
          return dialog && getComputedStyle(dialog).opacity === "1";
        });
        const visibleAndClickable = await page
          .getByTestId("project-folder-trust-confirm")
          .evaluate((button) => {
            const box = button.getBoundingClientRect();
            return (
              box.left >= 0 &&
              box.right <= innerWidth &&
              box.top >= 0 &&
              box.bottom <= innerHeight &&
              button.contains(
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
              )
            );
          });
        expect(visibleAndClickable).toBe(true);
        await page.screenshot({
          path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `PCFT11-mobile-trust-${theme}.png`),
          animations: "disabled",
        });
      }
      await page.evaluate(
        (value) => (window as VirtualProjectTestWindow).__testActions!.setTheme(value),
        mobileTheme,
      );
      await page.getByTestId("project-folder-trust-confirm").tap();
      await page.locator('[data-mobile-page="chat"]').waitFor();
      await page
        .getByTestId("composer-workspace-trigger")
        .filter({ hasText: "E2E_VP19_MOBILE_PROJECT" })
        .waitFor();
      await page.screenshot({
        path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "PCD03-mobile-created-project.png"),
      });
      await page.getByRole("button", { name: /Back to task home/ }).tap();
      enterStage("project draft");
      await browser.keys("Escape");
      await mobileProject.getByTestId("virtual-project-create-task").click();
      const readDraft = () =>
        page.evaluate(() => {
          const tabs = (window as VirtualProjectTestWindow).__zcodeTabStoreE2E?.getState();
          const path = tabs?.activeWorkspacePath;
          const draft = path
            ? (window as VirtualProjectTestWindow).__zcodeSessionStoreE2E
                ?.getState()
                .getWorkspaceState(path, tabs?.activeWorkspaceIdentity ?? undefined)
            : undefined;
          return { path, projectId: draft?.draftProjectId, activeTaskId: draft?.activeTaskId };
        });
      await page.locator('[data-mobile-page="chat"]').waitFor();
      await browser.waitUntil(async () => (await readDraft()).projectId === projectId, {
        timeout: 30_000,
      });
      expect(await readDraft()).toEqual({ path: cwd, projectId, activeTaskId: null });
      enterStage("D3 mobile inherits active project draft");
      await page.getByRole("button", { name: /Back to task home/ }).tap();
      await mobileProject.waitFor();
      await page.getByTestId("task-new-button").tap();
      await page.locator('[data-mobile-page="chat"]').waitFor();
      await browser.waitUntil(async () => (await readDraft()).projectId === projectId);
      expect(await readDraft()).toEqual({ path: cwd, projectId, activeTaskId: null });
      enterStage("persist task");
      for (const theme of ["zai-light", "zai-dark"]) {
        // The theme test entry unmounts with the home page; set the theme from the home page, then enter the real chat page through the project entry.
        await page.getByRole("button", { name: /Back to task home/ }).tap();
        await mobileProject.waitFor();
        await page.evaluate(
          (theme) => (window as VirtualProjectTestWindow).__testActions!.setTheme(theme),
          theme,
        );
        await page.waitForFunction(
          (theme) => document.documentElement.classList.contains(`theme-${theme}`),
          theme,
        );
        await mobileProject.getByTestId("virtual-project-create-task").tap();
        await page.locator('[data-mobile-page="chat"]').waitFor();
        await browser.waitUntil(async () => (await readDraft()).projectId === projectId);
        const trigger = page.getByTestId(TID_COMPOSER_WORKSPACE_TRIGGER);
        expect(await trigger.locator(".lucide-folders").count()).toBe(1);
        if (theme === "zai-light") {
          await page.getByTestId(TID_V4_COMPOSER_INPUT).fill("E2E_COMPOSER_CREATE_DRAFT");
          await page
            .locator('input[type="file"]')
            .last()
            .setInputFiles({
              name: "E2E_PCD_mobile.txt",
              mimeType: "text/plain",
              buffer: Buffer.from("mobile draft attachment"),
            });
        }
        const edit = page.getByTestId("composer-edit-project");
        await edit.waitFor();
        await page.locator('[data-branch-switcher-primary-icon="true"]').waitFor();
        const placement = await edit.evaluate((button) => {
          const branch = button.parentElement!.querySelector(
            '[data-branch-switcher-primary-icon="true"]',
          )!.parentElement!;
          return {
            branchRight: branch.getBoundingClientRect().right,
            editLeft: button.getBoundingClientRect().left,
          };
        });
        expect(placement.editLeft).toBeGreaterThanOrEqual(placement.branchRight);
        const beforeEdit = await readDraft();
        const draftText = await page.getByTestId(TID_V4_COMPOSER_INPUT).textContent();
        await page.screenshot({
          path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP13-composer-edit-${theme}.png`),
          animations: "disabled",
        });
        const editBounds = await edit.boundingBox();
        expect(editBounds!.x + editBounds!.width).toBeLessThanOrEqual(390);
        await edit.tap();
        const name = page.getByTestId("virtual-project-name");
        expect(await name.inputValue()).toBe("E2E_VP13_PROJECT");
        await page.screenshot({
          path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP13-project-editor-${theme}.png`),
          animations: "disabled",
        });
        await name.fill("E2E_MOBILE_EDIT_CANCELLED");
        await page.getByRole("button", { name: /^(Cancel)$/ }).tap();
        await name.waitFor({ state: "hidden" });
        expect(await trigger.textContent()).toContain("E2E_VP13_PROJECT");
        if (theme === "zai-light") {
          await edit.tap();
          await name.fill("E2E_VP13_EDITED");
          await page.getByTestId("virtual-project-save").tap();
          await name.waitFor({ state: "hidden" });
          expect(await trigger.textContent()).toContain("E2E_VP13_EDITED");
          await $('[data-project-name="E2E_VP13_EDITED"]').waitForDisplayed();
          await edit.tap();
          await name.fill("E2E_VP13_PROJECT");
          await page.getByTestId("virtual-project-save").tap();
          await name.waitFor({ state: "hidden" });
        }
        expect(await readDraft()).toEqual(beforeEdit);
        expect(await page.getByTestId(TID_V4_COMPOSER_INPUT).textContent()).toBe(draftText);
        await trigger.tap();
        const menu = page.getByTestId("composer-project-menu");
        await menu.locator('[data-project-name="E2E_VP13_PROJECT"] .lucide-folders').waitFor();
        await menu
          .locator('[data-project-name="E2E_VP19_MOBILE_PROJECT"] .lucide-folder')
          .waitFor();
        await page.waitForFunction(() => {
          const menu = document.querySelector('[data-testid="composer-project-menu"]');
          return menu && getComputedStyle(menu).opacity === "1";
        });
        await page.screenshot({
          path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP13-folders-composer-${theme}.png`),
          animations: "disabled",
        });
        if (theme === "zai-light") {
          enterStage("PCD03 composer create retains draft");
          const beforeCreate = await readDraft();
          await menu.getByTestId("composer-create-project").tap();
          await menu.waitFor({ state: "hidden" });
          await page.getByTestId("virtual-project-name").fill("E2E_COMPOSER_MOBILE_CANCELLED");
          await page.getByRole("button", { name: /^(Cancel)$/ }).tap();
          await page.getByTestId("virtual-project-name").waitFor({ state: "hidden" });
          expect(await readDraft()).toEqual(beforeCreate);
          expect(await page.getByTestId(TID_V4_COMPOSER_INPUT).textContent()).toBe(
            "E2E_COMPOSER_CREATE_DRAFT",
          );
          await trigger.tap();
          expect(
            await menu.locator('[data-project-name="E2E_COMPOSER_MOBILE_CANCELLED"]').count(),
          ).toBe(0);
          await menu.getByTestId("composer-create-project").tap();
          await page.getByTestId("virtual-project-name").fill("E2E_COMPOSER_MOBILE_CREATED");
          await page.screenshot({
            path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP13-composer-create.png"),
            animations: "disabled",
          });
          await page.getByTestId("virtual-project-save").tap();
          await page.getByTestId("virtual-project-name").waitFor({ state: "hidden" });
          // PCD01: a successful save now selects the new project; read the state only after the shared-host draft handoff completes.
          await page
            .getByTestId(TID_COMPOSER_WORKSPACE_TRIGGER)
            .filter({ hasText: "E2E_COMPOSER_MOBILE_CREATED" })
            .waitFor();
          const createdDraft = await readDraft();
          expect(createdDraft.activeTaskId).toBeNull();
          expect(createdDraft.projectId).toBeTruthy();
          expect(createdDraft.projectId).not.toBe(beforeCreate.projectId);
          await page
            .getByTestId(TID_V4_COMPOSER_INPUT)
            .filter({ hasText: "E2E_COMPOSER_CREATE_DRAFT" })
            .waitFor();
          await page
            .locator('[data-upload-status="ready"]')
            .filter({ hasText: "E2E_PCD_mobile.txt" })
            .waitFor();
          await page.screenshot({
            path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "PCD03-mobile-preserved-draft.png"),
          });
          await trigger.tap();
          await menu.locator('[data-project-name="E2E_COMPOSER_MOBILE_CREATED"]').waitFor();
        }
        await menu.locator('[data-project-name="E2E_VP13_PROJECT"]').tap();
        await menu.waitFor({ state: "hidden" });
        if (theme === "zai-light") {
          await browser.waitUntil(async () => (await readDraft()).projectId === projectId);
          // Ordinary manual switching still restores each workspace's own draft.
        }
      }
      await page
        .getByTestId(TID_V4_COMPOSER_INPUT)
        .fill("E2E_VP13_HISTORY: Reply with E2E_VP13_HISTORY_READY.");
      enterStage("reload project draft");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.locator('[data-mobile-page="chat"]').waitFor({ timeout: 30_000 });
      await browser.waitUntil(async () => (await readDraft()).projectId === projectId, {
        timeout: 30_000,
      });
      expect(await readDraft()).toEqual({ path: cwd, projectId, activeTaskId: null });
      expect(await page.getByTestId(TID_V4_COMPOSER_INPUT).textContent()).toBe(
        "E2E_VP13_HISTORY: Reply with E2E_VP13_HISTORY_READY.",
      );
      enterStage("submit recovered project draft");
      await page.getByTestId(TID_V4_COMPOSER_SEND).click();
      await page.getByText("E2E_VP13_HISTORY_READY", { exact: true }).waitFor({ timeout: 60_000 });
      const projectTaskState = await readDraft();
      const createdTaskId = projectTaskState.activeTaskId;
      expect(createdTaskId).toBeTruthy();
      enterStage("D3 mobile inherits persisted session project");
      await page.getByRole("button", { name: /Back to task home/ }).click();
      await page.getByTestId("task-new-button").click();
      await page.locator('[data-mobile-page="chat"]').waitFor();
      await browser.waitUntil(async () => (await readDraft()).activeTaskId === null);
      expect(await readDraft()).toEqual({ path: cwd, projectId, activeTaskId: null });
      enterStage("global draft");
      await page.getByRole("button", { name: /Back to task home/ }).click();
      await page.getByTestId("virtual-project-new-task").click();
      await page.locator('[data-mobile-page="chat"]').waitFor();
      await browser.waitUntil(async () => (await readDraft()).path !== cwd, { timeout: 30_000 });
      const globalDraft = await readDraft();
      expect(globalDraft.projectId).toBeNull();
      expect(await page.getByTestId("composer-edit-project").count()).toBe(0);
      expect(globalDraft.path).toContain(join(testHome, ".zcode/workspace"));
      enterStage("PD01/02/10 mobile pending task directory and draft recovery");
      const taskInput = page.getByTestId(TID_V4_COMPOSER_INPUT);
      await taskInput.fill("E2E_PD_MOBILE_DRAFT");
      await page.getByRole("button", { name: /Back to task home/ }).click();
      await page.getByTestId("virtual-project-new-task").click();
      await taskInput.waitFor();
      expect(await readDraft()).toEqual(globalDraft);
      expect(await taskInput.textContent()).toBe("E2E_PD_MOBILE_DRAFT");
      await page.reload({ waitUntil: "domcontentloaded" });
      await taskInput.waitFor({ timeout: 30_000 });
      expect(await readDraft()).toEqual(globalDraft);
      expect(await taskInput.textContent()).toBe("E2E_PD_MOBILE_DRAFT");
      await taskInput.fill("E2E_VP13_HISTORY: Reply with E2E_VP13_HISTORY_READY.");
      await page.getByTestId(TID_V4_COMPOSER_SEND).click();
      await page.getByText("E2E_VP13_HISTORY_READY", { exact: true }).waitFor({ timeout: 60_000 });
      expect((await readDraft()).activeTaskId).toBeTruthy();
      await page.getByRole("button", { name: /Back to task home/ }).click();
      await page.getByTestId("virtual-project-new-task").click();
      await taskInput.waitFor();
      expect((await readDraft()).path).not.toBe(globalDraft.path);
      expect(await taskInput.textContent()).toBe("");
      expect(
        await browser.execute(
          () => (window as VirtualProjectTestWindow).__zcodeTabStoreE2E?.getState().tabs.length,
        ),
      ).toBe(desktopTabs);
      await page.getByRole("button", { name: /Back to task home/ }).click();
      const toggle = mobileProject.getByTestId("virtual-project-toggle");
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      const taskRow = page.getByTestId(testId(TID_TASK_ITEM, createdTaskId!));
      enterStage("desktop task hover");
      const desktopToggle = project.$('[data-testid="virtual-project-toggle"]');
      if ((await desktopToggle.getAttribute("aria-expanded")) !== "true")
        await desktopToggle.click();
      const desktopTask = $(`[data-testid="${testId(TID_TASK_ITEM, createdTaskId!)}"]`);
      await desktopTask.waitForDisplayed();
      await desktopTask.moveTo();
      await browser.waitUntil(
        async () => !(await desktopTask.$("[data-task-row-metadata]").isDisplayed()),
      );
      // Move the desktop pointer out of the project area that reflows, so a newly pinned row on the phone does not land under the pointer and hide the access marker.
      await $('[data-testid="task-new-button"]').moveTo();
      await desktopTask.$("[data-task-row-metadata]").waitForDisplayed();
      enterStage("mobile task list gestures");
      process.stderr.write(
        `VP13 project gesture: ${JSON.stringify(
          await toggle.evaluate((node) => ({
            roleDescription: node.getAttribute("aria-roledescription"),
            touchAction: getComputedStyle(node).touchAction,
          })),
        )}\n`,
      );
      expect(await toggle.getAttribute("aria-roledescription")).not.toBe("sortable");
      expect(await toggle.evaluate((node) => getComputedStyle(node).touchAction)).toBe("pan-y");
      const projectBounds = await toggle.boundingBox();
      if (!projectBounds) throw new Error("mobile project toggle has no bounds");
      const touch = { x: projectBounds.x + 40, y: projectBounds.y + projectBounds.height / 2 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...touch, y: touch.y + 45 }],
      });
      expect(await page.getByTestId("project-drop-indicator").count()).toBe(0);
      expect(await mobileProject.evaluate((node) => getComputedStyle(node).transform)).toBe("none");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      // Touch browsers synthesize mouseover/focus before click; the layout must not switch to the desktop action state first.
      await taskRow.dispatchEvent("mouseover");
      await taskRow.focus();
      const metadata = taskRow.locator("[data-task-row-metadata]");
      expect(await metadata.isVisible()).toBe(true);
      await taskRow.tap();
      await page.locator('[data-mobile-page="chat"]').waitFor();
      expect((await readDraft()).activeTaskId).toBe(createdTaskId);
      await page.getByRole("button", { name: /Back to task home/ }).tap();
      enterStage("file-only cross-workspace bridge");
      // Phone remote control originally disables native session drag; shared target decorations must not accidentally enable that gesture or change the container size.
      expect(await taskRow.getAttribute("draggable")).toBe("false");
      for (const theme of ["zai-light", "zai-dark"]) {
        await page.evaluate(
          (theme) => (window as VirtualProjectTestWindow).__testActions!.setTheme(theme),
          theme,
        );
        expect(await page.getByTestId("project-session-drop-target").count()).toBe(0);
        await toggle.locator(".lucide-folders-open").waitFor();
        await toggle.tap();
        await toggle.locator(".lucide-folders").waitFor();
        await page.screenshot({
          path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP13-folders-closed-${theme}.png`),
          animations: "disabled",
        });
        await toggle.tap();
        await toggle.locator(".lucide-folders-open").waitFor();
        await taskRow.waitFor();
        const bounds = await mobileProject.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        await page.screenshot({
          path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP15-mobile-project-${theme}.png`),
          animations: "disabled",
        });
      }
      await taskRow.click({ button: "right" });
      await page.getByRole("menuitem", { name: /^(Pin task)$/ }).click();
      await page.getByTestId(`task-files-${createdTaskId}`).waitFor();
      await page.getByTestId(`task-files-${createdTaskId}`).click();
      // The file entry has moved to the right-side tab; the old sidebar panel is no longer mounted, but the file and workspace assertions keep their original meaning.
      await page
        .getByTestId("workspace-file-tree-panel")
        .getByText("E2E_VP13_FILES.txt", { exact: true })
        .waitFor({ timeout: 30_000 });
      const filesDraft = await readDraft();
      expect(filesDraft.path).toBe(cwd);
      expect(filesDraft.activeTaskId).toBe(projectTaskState.activeTaskId);
      await page.screenshot({
        path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP13-file-only-mobile.png"),
      });
      await page.locator('[data-side-pane-tab-id][data-state="active"] button[aria-label]').click();
      await page.getByTestId("workspace-file-tree-panel").waitFor({ state: "detached" });
      await page.getByRole("button", { name: /Back to task home/ }).tap();
      enterStage("reopen task");
      await page.getByTestId("sidebar-view-menu").tap();
      await page.getByTestId("sidebar-view-timeline").tap();
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await page.getByTestId("project-timeline-tasks").waitFor();
      expect(await page.getByTestId(testId(TID_TASK_ITEM, createdTaskId!)).count()).toBe(1);
      const timelineRow = page.getByTestId(testId(TID_TASK_ITEM, createdTaskId!));
      expect(await timelineRow.locator('[data-idle-indicator="true"]').count()).toBe(0);
      expect(await timelineRow.locator("[data-task-workspace-label]").textContent()).toBe(
        cwd.split(/[\\/]/).at(-1),
      );
      expect(await page.locator('[data-timeline-date-heading="today"]').isVisible()).toBe(true);
      const timelineLayout = await timelineRow.evaluate((row) => {
        const title = row
          .querySelector('[data-task-title-copy="original"]')!
          .getBoundingClientRect();
        const label = row.querySelector("[data-task-workspace-label]")!.getBoundingClientRect();
        const time = row.querySelector("[data-task-row-metadata]")!.getBoundingClientRect();
        return {
          below: label.top >= title.bottom,
          timeVisible: time.width > 0,
          inside: row.getBoundingClientRect().right <= innerWidth,
        };
      });
      expect(timelineLayout).toEqual({ below: true, timeVisible: true, inside: true });
      await page.getByTestId(testId(TID_TASK_ITEM, createdTaskId!)).click();
      await page.locator('[data-mobile-page="chat"]').waitFor();
      await page.getByText("E2E_VP13_HISTORY_READY", { exact: true }).waitFor();
      expect((await readDraft()).activeTaskId).toBe(createdTaskId);
      expect((await readDraft()).path).toBe(cwd);
      await browser.waitUntil(
        async () => {
          const row = $(`[data-testid="${testId(TID_TASK_ITEM, createdTaskId!)}"]`);
          return row.$('[data-mobile-active-task="true"]').isExisting();
        },
        {
          timeout: 30_000,
          timeoutMsg: "desktop sidebar must identify the task currently viewed on mobile",
        },
      );
      expect((await readHostProcesses()).length).toBe(hostCount);
      await closeResourceManagerWindow();
      await page.getByRole("button", { name: /Back to task home/ }).click();
      await page.getByTestId("sidebar-view-menu").tap();
      await page.getByTestId("sidebar-view-projects").tap();
      await page.getByRole("menu").waitFor({ state: "hidden" });
      expect((await readDraft()).activeTaskId).toBe(createdTaskId);
      await page.getByTestId("sidebar-view-menu").tap();
      await page.getByTestId("sidebar-view-timeline").tap();
      await page.getByRole("menu").waitFor({ state: "hidden" });
      expect((await readDraft()).activeTaskId).toBe(createdTaskId);
      await page.screenshot({
        path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "SBV06-mobile-recent.png"),
      });
      enterStage("SBV07 mobile unread filter and compare-and-clear");
      await callHandoffHost(ServiceChannels.WindowController, "mutateTask", [
        {
          address: { workspacePath: cwd, taskId: createdTaskId },
          mutation: { kind: "mark-unread" },
        },
      ]);
      await page.getByTestId("sidebar-view-menu").tap();
      expect(
        await page.getByTestId("sidebar-view-unread").locator("svg.lucide-bell").isVisible(),
      ).toBe(true);
      await page.getByTestId("sidebar-view-unread").tap();
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await page.getByTestId("project-unread-tasks").waitFor();
      expect(await page.locator('[data-testid^="task-item-"]').count()).toBe(1);
      for (const theme of ["zai-light", "zai-dark"]) {
        await page.evaluate(
          (theme) => (window as VirtualProjectTestWindow).__testActions!.setTheme(theme),
          theme,
        );
        await page.waitForFunction(
          (theme) => document.documentElement.classList.contains(`theme-${theme}`),
          theme,
        );
        await page.screenshot({
          path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `SBV07-mobile-unread-${theme}.png`),
        });
      }
      await page.getByTestId(testId(TID_TASK_ITEM, createdTaskId!)).tap();
      await page.getByText("E2E_VP13_HISTORY_READY", { exact: true }).waitFor();
      await page.getByRole("button", { name: /Back to task home/ }).tap();
      await page.getByTestId("project-no-tasks").waitFor();
      expect(await page.getByTestId("project-no-tasks").textContent()).toMatch(
        /暂无未读任务|No unread tasks/,
      );
      expect((await readDraft()).activeTaskId).toBe(createdTaskId);
      expect((await readHostProcesses()).length).toBe(hostCount);
      await closeResourceManagerWindow();
      await page.getByTestId("sidebar-view-menu").tap();
      await page.getByTestId("sidebar-view-timeline").tap();
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await page.getByTestId(testId(TID_TASK_ITEM, createdTaskId!)).tap();
      await page.getByText("E2E_VP13_HISTORY_READY", { exact: true }).waitFor();
      await page.screenshot({
        path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP13-mobile-project-history.png"),
      });
      // PCD01/02: verify the two desktop entries, light and dark themes, and existing-session isolation within the same isolated Electron instance.
      const desktopConnection = await browser.getPuppeteer();
      const desktopResult = await promisify(execFile)(
        process.execPath,
        [
          "--test",
          join(
            process.cwd(),
            "../ui/test/browser/manual-review/pending/project-created-draft.test.mjs",
          ),
        ],
        { env: { ...process.env, ZCODE_E2E_CDP_URL: desktopConnection.wsEndpoint() } },
      );
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "PCD-desktop.log"),
        desktopResult.stdout,
      );
      enterStage("PDN01 mobile new task after peer deletes the active project");
      expect((await readDraft()).activeTaskId).toBe(createdTaskId);
      // Delete through the real command on the desktop Host; the phone keeps the current history, then hands off the draft through the shared new-task entry.
      await callHandoffHost(ServiceChannels.Project, "deleteProject", [projectId, "local"]);
      await page.getByRole("button", { name: /Back to task home/ }).tap();
      await page.getByTestId("task-new-button").tap();
      await page.locator('[data-mobile-page="chat"]').waitFor();
      await browser.waitUntil(async () => {
        const draft = await readDraft();
        return Boolean(draft.path && draft.path !== cwd && draft.activeTaskId === null);
      });
      expect((await readDraft()).projectId).toBeNull();
      await page.getByTestId(TID_V4_COMPOSER_INPUT).fill("E2E_PDN01_MOBILE_DRAFT");
      expect(await page.getByTestId(TID_V4_COMPOSER_INPUT).textContent()).toBe(
        "E2E_PDN01_MOBILE_DRAFT",
      );
      await page.screenshot({
        path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "PDN01-mobile-deleted-project.png"),
      });
      expect(
        navigationDiagnostics.filter(
          (entry) =>
            (entry as { kind?: string; type?: string }).kind === "vite" &&
            (entry as { kind?: string; type?: string }).type === "full-reload",
        ),
      ).toEqual([]);
    } catch (error) {
      process.stderr.write(
        `VP13 failed stage: ${stage}; kind: ${error instanceof Error ? error.name : "unknown"}\n`,
      );
      if (mobilePage)
        process.stderr.write(
          `VP13 failure DOM: ${JSON.stringify(await mobilePage.evaluate(() => Array.from(document.querySelectorAll('[data-project-sidebar-panel], [data-testid="sidebar-view-menu"]')).map((n) => ({ kind: n.getAttribute("data-project-sidebar-panel") ?? n.getAttribute("data-testid"), hidden: n.getAttribute("aria-hidden"), rect: n.getBoundingClientRect().toJSON(), scroll: n.parentElement?.scrollLeft, children: n.childElementCount }))))}\n`,
        );
      await mobilePage
        ?.screenshot({
          path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP13-failed-stage.png"),
          timeout: 5_000,
        })
        .catch(() => {});
      throw error;
    } finally {
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP13-navigation-events.json"),
        JSON.stringify(navigationDiagnostics, null, 2),
      );
      // The loopback receiver is only for this case; desktop fetch keep-alive must not mask the original failure as a Mocha timeout.
      pairReceiver.closeAllConnections();
      await new Promise<void>((resolve) => pairReceiver.close(() => resolve()));
      await browser.execute(() => {
        const target = window as VirtualProjectTestWindow;
        target.__vp13RestoreClipboard?.();
        delete target.__vp13RestoreClipboard;
      });
      // Release the context that holds the remote-control WebSocket/CDP listeners first, then end the test browser process.
      enterStage("cleanup mobile context");
      await mobilePage?.context().close();
      enterStage("cleanup mobile browser");
      await mobileBrowser?.close();
      enterStage("cleanup completed");
    }
  });
});

async function openLocalProjectEditor() {
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').waitForDisplayed();
}
async function chooseProjectRoot(path: string) {
  await selectNativeProjectDirectories([path]);
}
