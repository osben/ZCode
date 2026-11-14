import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { selectNativeProjectDirectories } from "#e2e/helpers/project-sidebar";
import { ServiceChannels } from "@zcode/shared";
import type { VirtualProject } from "@zcode/services";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";

type ThemeWindow = typeof window & {
  __testActions?: {
    getTheme(): string;
    setTheme(theme: string): void;
    getLocale(): "zh-CN" | "en-US";
    setLocale(locale: "en-US" | "uk-UA" | "zh-CN"): void;
  };
};

describe("Local project native multi-folder selection", () => {
  const root = join(DEFAULT_WORKSPACE, ".zcode-e2e", "native-project-picker");
  const paths = ["one", "two", "three"].map((name) => join(root, name));
  const project = '[data-project-name="E2E_NATIVE_PROJECT_PICKER"]';

  before(async () => {
    await waitForDefaultWorkspaceReady(30_000);
    await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
    await installHandoffRpcProbe();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await restoreHandoffProbes();
    await rm(root, { recursive: true, force: true });
  });

  it("NDP01/NDP02/PRO01: a new multi-folder project ranks first and persists across refresh and reopen", async () => {
    const readProjectOrder = () =>
      browser.execute(() =>
        [...document.querySelectorAll('[data-testid="project-section"] [data-project-name]')].map(
          (element) => element.getAttribute("data-project-name"),
        ),
      );
    const previousOrder = await readProjectOrder();
    expect(previousOrder.length).toBeGreaterThan(0);
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_NATIVE_PROJECT_PICKER");
    await selectNativeProjectDirectories(paths.slice(0, 2));
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(2);
    await $$('[data-testid="virtual-project-root-row"]')[1]!
      .$('[data-testid="virtual-project-set-primary"]')
      .click();
    await selectNativeProjectDirectories([paths[1]!, paths[2]!]);
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(3);
    await selectNativeProjectDirectories([]);
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(3);
    expect(
      await $$('[data-testid="virtual-project-root-row"]')[1]!
        .$('[data-testid="virtual-project-primary"]')
        .isExisting(),
    ).toBe(true);
    // PCFT01/02/03: read the real Host before confirming; cancel must not leave a project behind or rewrite the draft.
    const readSaved = () =>
      callHandoffHost<VirtualProject[]>(ServiceChannels.Project, "readProjects");
    const before = await readSaved();
    for (const action of ["cancel", "close", "escape", "outside"]) {
      await $('[data-testid="virtual-project-save"]').click();
      const dialog = $('[data-testid="project-folder-trust-dialog"]');
      await dialog.waitForDisplayed();
      expect(
        await $$('[data-testid="project-folder-trust-path"]').map((row) => row.getText()),
      ).toEqual(paths);
      expect(await readSaved()).toEqual(before);
      if (action === "cancel") {
        expect(
          await browser.execute(() => document.activeElement?.getAttribute("data-testid")),
        ).toBe("project-folder-trust-cancel");
        await browser.keys("Enter");
      } else if (action === "close") {
        await dialog.$('[data-slot="dialog-close"]').click();
      } else if (action === "escape") {
        await browser.keys("Escape");
      } else {
        await browser.action("pointer").move({ x: 8, y: 8 }).down().up().perform();
      }
      await dialog.waitForExist({ reverse: true });
      expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(
        "E2E_NATIVE_PROJECT_PICKER",
      );
      expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(3);
      await browser.waitUntil(() =>
        browser.execute(
          () => document.activeElement?.getAttribute("data-testid") === "virtual-project-save",
        ),
      );
      expect(await readSaved()).toEqual(before);
    }
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-dialog"]').waitForDisplayed();
    // Electron has no Browser.getWindowForTarget; window size is adjusted through a real BrowserWindow.
    const windowSize = await browser.electron.execute((electron) => {
      const appWindow = electron.BrowserWindow.getAllWindows()[0]!;
      return { bounds: appWindow.getBounds(), minimum: appWindow.getMinimumSize() };
    });
    const trustViewport = await browser.execute(() => ({ width: innerWidth, height: innerHeight }));
    const trustTheme = await browser.execute(() =>
      (window as ThemeWindow).__testActions!.getTheme(),
    );
    const trustLocale = await browser.execute(() =>
      (window as ThemeWindow).__testActions!.getLocale(),
    );
    try {
      for (const width of [1200, 390]) {
        await browser.execute(
          (viewportWidth) =>
            (window as ThemeWindow).__testActions!.setLocale(
              viewportWidth === 1200 ? "en-US" : "zh-CN",
            ),
          width,
        );
        await browser.electron.execute((electron, nextWidth) => {
          const appWindow = electron.BrowserWindow.getAllWindows()[0]!;
          appWindow.setMinimumSize(320, 480);
          appWindow.setSize(nextWidth, 844);
        }, width);
        await browser.waitUntil(() =>
          browser.execute((nextWidth) => innerWidth === nextWidth, width),
        );
        for (const theme of ["zai-light", "zai-dark"]) {
          await browser.execute(
            (value) => (window as ThemeWindow).__testActions!.setTheme(value),
            theme,
          );
          await waitForTrustLayout({ width, height: 844 });
          const geometry = await browser.execute(() => {
            const button = document.querySelector('[data-testid="project-folder-trust-confirm"]')!;
            const box = button.getBoundingClientRect();
            return {
              visible:
                box.left >= 0 &&
                box.right <= innerWidth &&
                box.top >= 0 &&
                box.bottom <= innerHeight,
              hit: button.contains(
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
              ),
            };
          });
          expect(geometry).toEqual({ visible: true, hit: true });
          expect(await $('[data-testid="project-folder-trust-dialog"]').getText()).toContain(
            width === 1200 ? "This computer" : "This computer",
          );
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `PCFT-trust-${width}-${theme}.png`),
          );
        }
      }
    } finally {
      await browser.electron.execute((electron, previous) => {
        const appWindow = electron.BrowserWindow.getAllWindows()[0]!;
        appWindow.setBounds(previous.bounds);
        appWindow.setMinimumSize(previous.minimum[0]!, previous.minimum[1]!);
      }, windowSize);
      await browser.execute(
        (value) => (window as ThemeWindow).__testActions!.setTheme(value),
        trustTheme,
      );
      await browser.execute(
        (locale) => (window as ThemeWindow).__testActions!.setLocale(locale),
        trustLocale,
      );
    }
    // When the native resize returns, the dialog's size transition may still be moving buttons; wait for the layout to settle so a single click does not miss.
    await waitForTrustLayout(trustViewport);
    expect(
      await browser.execute(() =>
        document
          .getAnimations()
          .filter((animation) => {
            const dialog = document.querySelector('[data-testid="project-folder-trust-dialog"]');
            const target = (animation.effect as KeyframeEffect | null)?.target;
            return (
              animation.playState === "running" &&
              animation instanceof CSSTransition &&
              /^(max-)?(width|height)$|^transform$/.test(animation.transitionProperty) &&
              target instanceof Element &&
              dialog &&
              (dialog.contains(target) || target.contains(dialog))
            );
          })
          .map((animation) => (animation as CSSTransition).transitionProperty),
      ),
    ).toEqual([]);
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
    expect(
      (await readSaved())
        .find((item) => item.name === "E2E_NATIVE_PROJECT_PICKER")
        ?.roots.map((item) => item.rootPath),
    ).toEqual(paths);
    // The narrow layout auto-collapses the sidebar; after restoring the size, expand it via the real entry, then check project order.
    if (!(await $('[data-testid="project-section"]').isDisplayed())) {
      await $('button[aria-label="Toggle sidebar"], button[aria-label="Toggle sidebar"]').click();
    }
    await $(project).waitForDisplayed();
    expect(await readProjectOrder()).toEqual(["E2E_NATIVE_PROJECT_PICKER", ...previousOrder]);
    await browser.refresh();
    // Creating the project already activated the chosen primary directory; waiting for the old fixture directory after refresh would misreport a correct restore as a navigation failure.
    await waitForWorkspaceApp(paths[1]!, 30_000);
    await $(project).waitForDisplayed();
    expect(await readProjectOrder()).toEqual(["E2E_NATIVE_PROJECT_PICKER", ...previousOrder]);
    await $(project).$('[data-testid="virtual-project-menu"]').click();
    await $('[data-testid="virtual-project-edit"]').click();
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    const rows = await $$('[data-testid="virtual-project-root-name"]');
    expect(await rows.map((row) => row.getAttribute("title"))).toEqual(paths);
    expect(
      await $$('[data-testid="virtual-project-root-row"]')[1]!
        .$('[data-testid="virtual-project-primary"]')
        .isExisting(),
    ).toBe(true);
    const originalTheme = await browser.execute(() =>
      (window as ThemeWindow).__testActions!.getTheme(),
    );
    try {
      for (const theme of ["zai-light", "zai-dark"]) {
        await browser.execute(
          (value) => (window as ThemeWindow).__testActions!.setTheme(value),
          theme,
        );
        await browser.waitUntil(() =>
          browser.execute(
            (value) => document.documentElement.classList.contains(`theme-${value}`),
            theme,
          ),
        );
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `native-project-${theme}.png`),
        );
      }
    } finally {
      await browser.execute(
        (value) => (window as ThemeWindow).__testActions!.setTheme(value),
        originalTheme,
      );
    }
    await browser.keys("Escape");
    await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
    await $(project).$('[data-testid="virtual-project-menu"]').click();
    await $('[data-testid="virtual-project-delete"]').click();
    // Project deletion is confirmed first (ISSUE-028).
    await $('[data-testid="confirm-dialog-confirm"]').waitForDisplayed();
    await $('[data-testid="confirm-dialog-confirm"]').click();
    await $(project).waitForExist({ reverse: true });
  });
});

async function waitForTrustLayout(viewport: { width: number; height: number }): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((expected) => {
        const dialog = document.querySelector('[data-testid="project-folder-trust-dialog"]');
        if (!dialog || innerWidth !== expected.width || innerHeight !== expected.height)
          return false;
        return !document.getAnimations().some((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          return (
            animation.playState === "running" &&
            animation instanceof CSSTransition &&
            /^(max-)?(width|height)$|^transform$/.test(animation.transitionProperty) &&
            target instanceof Element &&
            (dialog.contains(target) || target.contains(dialog))
          );
        });
      }, viewport),
    { timeout: 10_000, timeoutMsg: "信任弹窗视口或布局过渡尚未完成" },
  );
}
