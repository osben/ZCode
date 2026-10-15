import { execFileSync } from "node:child_process";
import { TID_WORKSPACE_ITEM, testId } from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  hoverTestIdByWebDriver,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "../helpers/desktop-app.js";

const GITHUB_REMOTE_NAME = "zcode-e2e-github";
const GITHUB_REMOTE_URL = "ssh://git@ssh.github.com:443/osben/ZCode.git";
const GITHUB_WEB_URL = "https://github.com/osben/ZCode";
const OPEN_GITHUB_TEST_ID = "workspace-open-on-github";

describe("workspace GitHub link E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("GHL-UI-01: opens the configured GitHub repository from the workspace actions", async function () {
    this.timeout(120_000);
    await waitForDefaultWorkspaceReady(30_000);
    await configureGitHubRemote();

    const external = await browser.electron.mock("shell", "openExternal");
    await external.mockResolvedValue(undefined);

    const rowTestId = testId(TID_WORKSPACE_ITEM, DEFAULT_WORKSPACE);
    await hoverTestIdByWebDriver(rowTestId);
    await openWorkspaceMenu(rowTestId);
    await waitForTestIdByDom(OPEN_GITHUB_TEST_ID, {
      timeoutMsg: "GitHub action did not appear for the configured workspace remote",
    });
    await clickTestIdByDom(OPEN_GITHUB_TEST_ID);

    await browser.waitUntil(
      async () => {
        await external.update();
        return external.mock.calls.some((call) => call[0] === GITHUB_WEB_URL);
      },
      { timeout: 10_000, timeoutMsg: `Workspace action did not open ${GITHUB_WEB_URL}` },
    );
  });
});

function configureGitHubRemote(): void {
  execFileSync("git", ["init", "-q"], { cwd: DEFAULT_WORKSPACE });
  const remotes = execFileSync("git", ["remote"], {
    cwd: DEFAULT_WORKSPACE,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
  if (remotes.includes(GITHUB_REMOTE_NAME)) {
    execFileSync("git", ["remote", "set-url", GITHUB_REMOTE_NAME, GITHUB_REMOTE_URL], {
      cwd: DEFAULT_WORKSPACE,
    });
    return;
  }
  execFileSync("git", ["remote", "add", GITHUB_REMOTE_NAME, GITHUB_REMOTE_URL], {
    cwd: DEFAULT_WORKSPACE,
  });
}

async function openWorkspaceMenu(rowTestId: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((testIdValue) => {
        const item = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (candidate) => candidate.dataset.testid === testIdValue,
        );
        const moreButton = Array.from(
          item?.closest("li")?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((button) => button.getAttribute("aria-label") === "More");
        if (!moreButton) return false;
        moreButton.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            pointerType: "mouse",
          }),
        );
        moreButton.click();
        return true;
      }, rowTestId),
    { timeout: 10_000, timeoutMsg: "Workspace action menu trigger did not appear" },
  );
}
