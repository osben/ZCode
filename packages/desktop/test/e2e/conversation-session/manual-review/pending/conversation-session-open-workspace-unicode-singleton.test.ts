import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearAppData, workspaceLabel } from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

// BUG-GWT-001 (docs/testing/git-worktree-qa/bugs/BUG-GWT-001.md):
// Opening a workspace whose path mixes non-Latin-1 characters with spaces via a second app
// instance (`--open-workspace <path>`) crashes the PRIMARY instance: Electron 41's process
// singleton tokenizes the hand-off message with base::TRIM_WHITESPACE around NUL delimiters,
// which strips the `0x20` byte of every space inside the V8-serialized two-byte
// additionalData payload. The primary then rejects the notification
// ("process_singleton_posix.cc:779 additional_data_size exceeds payload length"), the second
// instance kills it and takes over the singleton.
// The defect is entirely inside Electron's patched Chromium (fixed upstream by
// electron/electron#52025, not backported to 41.x), so the lowest reproducible layer is this
// E2E spec: it must stay pending until the bug is fixed (Electron upgrade or app-side path
// encoding), then pass green after manual review per .agents/skills/e2e-case-lifecycle/SKILL.md.

interface PrimaryProcessSnapshot {
  pid: number;
  execPath: string;
  appArgs: string[];
}

const SECOND_INSTANCE_EXIT_TIMEOUT_MS = 30_000;

function createSpaceUnicodeWorkspace(): string {
  // The directory name must force V8's two-byte string serialization (any char > U+00FF,
  // here Cyrillic) AND contain at least one ASCII space: that exact combination corrupts
  // the singleton payload. Self-contained temp data; removed in finally.
  const root = mkdtempSync(join(tmpdir(), "zcode-e2e-open-workspace-"));
  const workspace = join(root, "проект с пробелами ü");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# BUG-GWT-001 workspace fixture\n");
  return workspace;
}

function runSecondInstanceUntilExit(primary: PrimaryProcessSnapshot, workspace: string) {
  return new Promise<{ code: number | null }>((resolve, reject) => {
    const child = spawn(
      primary.execPath,
      [...primary.appArgs, "--open-workspace", workspace],
      // The worker env carries the same HOME/userData identity the primary was launched
      // with, so the second instance resolves the same process singleton socket.
      { env: process.env, stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("second instance did not exit after handing off the workspace"));
    }, SECOND_INSTANCE_EXIT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

describe("第二实例打开含空格与 unicode 路径的工作区 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BUG-GWT-001: --open-workspace с пробелами и unicode открывает проект и не убивает первичное приложение", async function () {
    this.timeout(120000);

    const workspace = createSpaceUnicodeWorkspace();
    try {
      await prepareV4ConversationE2E({ skipProvider: true });

      const primary = (await browser.electron.execute(
        () =>
          ({
            pid: process.pid,
            execPath: process.execPath,
            appArgs: process.argv.slice(1),
          }) as PrimaryProcessSnapshot,
      )) as PrimaryProcessSnapshot;
      expect(primary.pid).toBeGreaterThan(0);

      // A healthy second instance hands the workspace to the primary and exits on its own.
      const second = await runSecondInstanceUntilExit(primary, workspace);
      expect(second.code).toBe(0);

      // The primary must have survived the hand-off (BUG-GWT-001: it is SIGKILLed, so this
      // execute call itself fails once the renderer/main session is gone).
      const pidAfter = (await browser.electron.execute(() => process.pid)) as number;
      expect(pidAfter).toBe(primary.pid);

      // And the workspace must actually open: its folder label becomes visible in the app.
      const label = workspaceLabel(workspace);
      await browser.waitUntil(async () => (await $$(`*=${label}`).length) > 0, {
        timeout: 30_000,
        timeoutMsg: "workspace with spaces/unicode never opened after second-instance hand-off",
      });
    } finally {
      rmSync(dirname(workspace), { recursive: true, force: true });
    }
  });
});
