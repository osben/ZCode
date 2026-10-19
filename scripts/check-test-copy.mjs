import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const roots = ["packages/ui/test", "packages/web/test", "packages/desktop/test/e2e"];
const localeAllowlist = new Set([
  "packages/ui/test/i18nCatalogParity.test.ts",
  "packages/ui/test/localeContentCatalogs.test.ts",
  "packages/ui/test/localeFormatting.test.ts",
  "packages/ui/test/localeSettingsSchema.test.ts",
  "packages/ui/test/localeSupport.test.ts",
  "packages/ui/test/intlProviderLocalePreference.test.ts",
  "packages/ui/test/browser/manual-review/pending/share-failure.test.mjs", // share error message text for network and HTTP 405 failures per locale
  "packages/ui/test/browser/manual-review/pending/start-plan-followup.test.mjs", // Start Plan follow-up UI copy and actions per zh-CN/en-US locale behavior
  "packages/ui/test/browser/manual-review/pending/thought-level-display.test.mjs", // thought-level option labels and aria-labels per locale
  "packages/ui/test/browser/manual-review/pending/topic-preparation.test.mjs", // bot topic-preparation layout across an en-US and zh-CN viewport/theme matrix
  "packages/ui/test/chatInputContextUsage.test.ts", // formatContextUsageSummary Chinese compact token units
  "packages/ui/test/intlPlural.test.ts", // createIntl zh-CN plural selection rules
  "packages/ui/test/offPeakNewTaskEntryLocale.test.ts", // off-peak banner, card and draft must stay in one language per zh-CN and en-US
  "packages/ui/test/remoteConnectionFieldsAuthMethodLayout.test.ts", // SSH auth-method layout compared across zh-CN and en-US labels
  "packages/ui/test/marketingPopupAdapter.test.ts", // Start popup settings button label per locale
  "packages/ui/test/modelProviderCodingPlan.test.ts", // zh-CN date formatting and billing-discount copy resolution
  "packages/ui/test/pluginStoreTryPrompt.test.ts", // localized plugin display label in the try prompt
  "packages/ui/test/remoteSkillSyncDialog.test.ts", // zh-CN size-limit error after a locale switch
  "packages/ui/test/savedWorkflowLaunchPrompt.test.ts", // zh-CN and en-US saved-workflow launch prompt output
  "packages/ui/test/v4ConversationRowViewTimelineMarker.test.ts", // timeline model-marker copy per zh-CN and en-US
  "packages/ui/test/workflowRunSave.test.ts", // zh-CN save-request prompt and saveRun catalog parity
  "packages/web/test/conversationShareLandingPage.test.ts",
  "packages/desktop/test/e2e/settings/settings-language-system-default.test.ts",
  "packages/desktop/test/e2e/help-client-config.test.ts",
  "packages/desktop/test/e2e/help-menu-about.test.ts",
  "packages/desktop/test/e2e/settings/settings-ui-polish.test.ts",
  "packages/desktop/test/e2e/plugins/manual-review/pending/plugin-localization-creator.test.ts",
  "packages/desktop/test/e2e/bots/feishu-bound-groups-ui.test.ts",
  "packages/desktop/test/e2e/bots/feishu-runtime-error-ui.test.ts",
  "packages/desktop/test/e2e/bots/feishu-streaming-card-lifecycle.test.ts",
  "packages/desktop/test/e2e/settings/provider-plan-navigation-labels.test.ts",
  "packages/desktop/test/e2e/coding-plan-team-usage.test.ts",
]);
const textLocatorMethods = new Set([
  "getByText",
  "queryByText",
  "findByText",
  "getAllByText",
  "queryAllByText",
  "findAllByText",
  "getByLabelText",
  "queryByLabelText",
  "findByLabelText",
  "getByPlaceholderText",
  "queryByPlaceholderText",
  "findByPlaceholderText",
  "getByTitle",
  "queryByTitle",
  "findByTitle",
]);
const roleLocatorMethods = new Set([
  "getByRole",
  "queryByRole",
  "findByRole",
  "getAllByRole",
  "queryAllByRole",
  "findAllByRole",
]);
const queryMethods = new Set([...textLocatorMethods, ...roleLocatorMethods]);

async function listTestFiles(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listTestFiles(path);
      return entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function findCallEnd(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

const violations = [];
for (const directory of roots) {
  for (const file of await listTestFiles(directory)) {
    const source = await readFile(join(root, file), "utf8");
    const relativePath = relative(root, file).replaceAll("\\", "/");
    const localeAllowed = localeAllowlist.has(relativePath);

    if (!localeAllowed) {
      const localeSetup =
        /\b(?:initialLocale|locale|navigator\.language)\s*[:=]\s*["'](?:zh-CN|zh-Hans-CN|zh_CN)["']/gu;
      // Defaults, constants and comparisons also select a locale, so they are checked too.
      const localeDefaultOrConstant =
        /(?:\?\?|=|\|\|)\s*["'](?:zh-CN|zh-Hans-CN|zh_CN)["']|\bLOCALE_ZH\b/gu;
      for (const match of [
        ...source.matchAll(localeSetup),
        ...source.matchAll(localeDefaultOrConstant),
      ]) {
        violations.push(`${relativePath}:${lineAt(source, match.index)}: non-English locale setup`);
      }
    }

    const methodPattern =
      /\b(getByText|queryByText|findByText|getAllByText|queryAllByText|findAllByText|getByRole|queryByRole|findByRole|getAllByRole|queryAllByRole|findAllByRole|getByLabelText|queryByLabelText|findByLabelText|getByPlaceholderText|queryByPlaceholderText|findByPlaceholderText|getByTitle|queryByTitle|findByTitle)\s*\(/gu;
    for (const match of source.matchAll(methodPattern)) {
      if (!queryMethods.has(match[1])) continue;
      const openIndex = match.index + match[0].lastIndexOf("(");
      const endIndex = findCallEnd(source, openIndex);
      if (endIndex < 0) continue;
      const args = source.slice(openIndex + 1, endIndex);
      // Only non-English copy locators are blocked here. English copy locators are a separate follow-up.
      if (/[\u3400-\u9fff]/u.test(args)) {
        violations.push(
          `${relativePath}:${lineAt(source, match.index)}: CJK copy used as UI locator`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  const localeViolationCount = violations.filter((violation) =>
    violation.includes("non-English locale setup"),
  ).length;
  const copyViolationCount = violations.length - localeViolationCount;
  process.stderr.write(
    `UI test copy convention violations (${violations.length}: ${localeViolationCount} locale, ${copyViolationCount} copy):\n`,
  );
  for (const violation of violations.slice(0, 100)) process.stderr.write(`- ${violation}\n`);
  if (violations.length > 100) {
    process.stderr.write(`- ... ${violations.length - 100} additional violations omitted\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write("UI test copy convention check passed.\n");
}
