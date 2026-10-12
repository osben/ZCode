import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Reads repository source for text-contract assertions.
 *
 * Bugfix: some assertions below contain multi-line fragments (`) : showCreateSettingsAction ? (\n
 * ...`), but the repo only declares `eol=lf` for *.mjs / *.sh; all other sources are CRLF in a
 * Windows checkout with `core.autocrlf=true`, so `toContain`'s `\n` never matches `\r\n` and the
 * case would always fail on Windows. What it asserts is a source-content contract, independent of
 * line-ending bytes, so everything is normalized to LF before comparison.
 */
async function readSource(url: URL): Promise<string> {
  return (await readFile(url, "utf8")).replaceAll("\r\n", "\n");
}

const editViewSource = await readSource(
  new URL("../src/settings/AutomationEditView.tsx", import.meta.url),
);
const offPeakEditViewSource = await readSource(
  new URL("../src/settings/OffPeakEditView.tsx", import.meta.url),
);
const primitivesSource = await readSource(
  new URL("../src/settings/AutomationDesignPrimitives.tsx", import.meta.url),
);
const segmentedTabsSource = await readSource(
  new URL("../src/settings/SettingsSegmentedTabs.tsx", import.meta.url),
);
const zhLocaleSource = await readSource(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url));

describe("automation new-task history interaction", () => {
  it("allows opening empty history without loading runs or showing create action", () => {
    expect(editViewSource).toContain("<AutomationSettingsHistoryTabs");
    expect(editViewSource).not.toContain("disabled={!editing}");
    expect(editViewSource).toContain(
      'const showCreateSettingsAction = !editing && tab === "settings";',
    );
    expect(editViewSource).toContain(") : showCreateSettingsAction ? (\n              <Button");
    expect(editViewSource).toContain('if (tab !== "history" || !editing) {\n      return;');
  });

  it("shares the Hooks pill tabs style and uses 设置 / 历史 labels", () => {
    expect(editViewSource).toContain("<AutomationSettingsHistoryTabs");
    expect(offPeakEditViewSource).toContain("<AutomationSettingsHistoryTabs");
    expect(primitivesSource).toContain("<SettingsSegmentedTabs");
    expect(segmentedTabsSource).toContain(
      'className="flex h-8 rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-8"',
    );
    expect(segmentedTabsSource).toContain(
      "h-7 flex-none rounded-full border-transparent bg-transparent px-2.5",
    );
    expect(segmentedTabsSource).toContain(
      "data-active:border-transparent data-active:bg-background",
    );
    expect(zhLocaleSource).toContain('"automations.edit.tab.history": "历史"');
  });
});
