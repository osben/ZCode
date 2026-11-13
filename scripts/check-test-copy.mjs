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
  "packages/ui/test/browser/manual-review/pending/share-failure.test.mjs", // share error message text for network and HTTP 405 failures per locale
  "packages/ui/test/browser/manual-review/pending/start-plan-followup.test.mjs", // Start Plan follow-up UI copy and actions per zh-CN/en-US locale behavior
  "packages/ui/test/browser/manual-review/pending/thought-level-display.test.mjs", // thought-level option labels and aria-labels per locale
  "packages/ui/test/browser/manual-review/pending/topic-preparation.test.mjs", // bot topic-preparation layout across an en-US and zh-CN viewport/theme matrix
  "packages/ui/test/intlPlural.test.ts", // createIntl zh-CN plural selection rules
  "packages/ui/test/offPeakNewTaskEntryLocale.test.ts", // off-peak banner, card and draft must stay in one language per zh-CN and en-US
  "packages/desktop/test/e2e/settings/general/settings-language-system-default.test.ts",
  "packages/desktop/test/e2e/feedback/help/help-client-config.test.ts",
  "packages/desktop/test/e2e/feedback/help/help-menu-about.test.ts",
  "packages/desktop/test/e2e/settings/general/settings-ui-polish.test.ts",
  "packages/desktop/test/e2e/plugins/marketplace/plugin-localization-creator.test.ts",
  "packages/desktop/test/e2e/bots/channels/feishu-bound-groups-ui.test.ts",
  "packages/desktop/test/e2e/bots/runtime/feishu-runtime-error-ui.test.ts",
  "packages/desktop/test/e2e/bots/delivery/feishu-streaming-card-lifecycle.test.ts",
  "packages/desktop/test/e2e/settings/providers/provider-plan-navigation-labels.test.ts",
  "packages/desktop/test/e2e/coding-plan/account/coding-plan-team-usage.test.ts",

  // Upstream 3.17.1 suites that run under both locales and pick copy per locale (`locale === "zh-CN" ? … : …`).
  "packages/desktop/test/e2e/conversation-session/task-management/conversation-session-archive-management.test.ts",
  "packages/desktop/test/e2e/conversation-session/automations/conversation-session-automation-pause-self.test.ts",
  "packages/desktop/test/e2e/conversation-session/hooks/conversation-session-hook-trust.test.ts",
  "packages/desktop/test/e2e/conversation-session/projects/conversation-session-project-missing-primary-root.test.ts",
  "packages/desktop/test/e2e/conversation-session/tools/conversation-session-tool-discovery-card.test.ts",
  "packages/desktop/test/e2e/conversation-session/sharing/conversation-session-gen-ui-context.test.ts",
  "packages/desktop/test/e2e/conversation-session/presentation/conversation-session-message-link-menu.test.ts",
  "packages/desktop/test/e2e/conversation-session/projects/conversation-session-project-management.test.ts",
  "packages/desktop/test/e2e/conversation-session/remote/data-sync/manual-review/pending/conversation-session-remote-data-sync-demo-walkthrough.test.ts",
  "packages/desktop/test/e2e/conversation-session/runtime/manual-review/pending/conversation-session-runtime-restart.test.ts",
  "packages/desktop/test/e2e/conversation-session/runtime/manual-review/pending/conversation-session-shared-cli.test.ts",
  "packages/ui/test/browser/manual-review/pending/workspace-hook-pending.test.mjs",
  "packages/ui/test/browser/manual-review/pending/yolo-confirmation.test.mjs",
  // Upstream 3.18.0 suites that check per-locale behavior: a light/dark x zh-CN/en-US layout
  // matrix, and the x-client-language header for each persisted language.
  "packages/desktop/test/e2e/conversation-session/projects/conversation-session-virtual-project.test.ts",
  "packages/desktop/test/e2e/settings/general/settings-client-language-header.test.ts",
  // Upstream 3.18.1 manual-review browser suites that render each fixture under zh-CN and en-US.
  "packages/ui/test/browser/manual-review/pending/font-smoothing.test.mjs",
  "packages/ui/test/browser/manual-review/pending/interaction-origin-badge.test.mjs",
]);
// Upstream 3.17.1 and 3.17.2 manual-review suites kept byte-identical to upstream (zh-CN default-locale copy and
// CJK locators). Both checks skip them; convert a suite to English copy and drop it here when the
// fork edits it.
const upstreamVerbatimSuites = new Set([
  // Upstream 3.18.0 suites kept byte-identical to upstream.
  "packages/desktop/test/e2e/auth-config/credentials/manual-review/pending/credential-store-recovery.test.ts",
  "packages/desktop/test/e2e/conversation-session/background/manual-review/pending/conversation-session-background-history-layout.test.ts",
  "packages/desktop/test/e2e/conversation-session/branching/conversation-session-fork-cold-start-membership.test.ts",
  "packages/desktop/test/e2e/conversation-session/hooks/manual-review/pending/conversation-session-hooks-mobile.test.ts",
  "packages/desktop/test/e2e/conversation-session/presentation/conversation-session-assistant-block-order.test.ts",
  "packages/desktop/test/e2e/conversation-session/presentation/conversation-session-status-panel-inline-layout.test.ts",
  "packages/desktop/test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-pdf-preview-mobile.test.ts",
  "packages/desktop/test/e2e/conversation-session/projects/conversation-session-project-management.test.ts",
  "packages/desktop/test/e2e/conversation-session/queue/conversation-session-queue-edit-freeze-mobile.test.ts",
  "packages/desktop/test/e2e/conversation-session/queue/conversation-session-v4-queue.test.ts",
  "packages/desktop/test/e2e/conversation-session/remote/mobile/manual-review/pending/conversation-session-r3-mobile-startup-restore.test.ts",
  "packages/desktop/test/e2e/conversation-session/remote/navigation/conversation-session-remote-sidebar-menus.test.ts",
  "packages/desktop/test/e2e/conversation-session/session-control/manual-review/pending/app-control-session-lifecycle.test.ts",
  "packages/desktop/test/e2e/conversation-session/task-management/conversation-session-v4-session-action-locks.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/manual-review/pending/plugin-extension-sessions.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-entries.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-host-runtime.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-jarvis-host.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-logs.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-mention.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-network.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-plugin-project.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-session-approvals.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-sessions-read.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-sessions-write.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-settings.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-start-draft.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-extension-views.test.ts",
  "packages/desktop/test/e2e/plugins/extensions/plugin-store-extension-compat.test.ts",
  "packages/desktop/test/e2e/plugins/marketplace/manual-review/pending/agent-plugin-discovery.test.ts",
  "packages/desktop/test/e2e/plugins/marketplace/manual-review/pending/plugin-design-builtin.test.ts",
  "packages/desktop/test/e2e/remote-control/authentication/manual-review/pending/web-remote-control-regional-login.test.ts",
  "packages/desktop/test/e2e/settings/agent/settings-agent-behavior.test.ts",
  "packages/desktop/test/e2e/settings/general/settings-navigation-search.test.ts",
  "packages/desktop/test/e2e/ui-shell/composer/composer-voice-input.test.ts",
  "packages/desktop/test/e2e/ui-shell/updates/manual-review/pending/update-window-background-download.test.mjs",
  "packages/ui/test/browser/manual-review/pending/data-sync-minimize.test.mjs",
  "packages/ui/test/browser/manual-review/pending/inline-image-mention.test.mjs",
  "packages/ui/test/browser/manual-review/pending/session-details.test.mjs",
  "packages/ui/test/browser/manual-review/pending/tool-summary-groups.test.mjs",
  "packages/desktop/test/e2e/conversation-session/runtime/conversation-session-id-compatibility.test.ts",
  "packages/desktop/test/e2e/conversation-session/projects/conversation-session-new-task-missing-root-mobile.test.ts",
  "packages/desktop/test/e2e/conversation-session/remote/connection/conversation-session-remote-draft-prewarm.test.ts",
  "packages/desktop/test/e2e/conversation-session/remote/mobile/manual-review/pending/conversation-session-web-remote-terminal.test.ts",
  "packages/desktop/test/e2e/conversation-session/plugins/conversation-session-workspace-mcp-trust.test.ts",
  "packages/desktop/test/e2e/settings/mcp/manual-review/pending/mcp-failure-guidance.test.ts",
  "packages/desktop/test/e2e/ui-shell/navigation/command-center-history-search.test.ts",
  "packages/ui/test/browser/manual-review/pending/image-preview-edit.test.mjs",
  "packages/ui/test/browser/manual-review/pending/plugin-marketplace-risk.test.mjs",
  "packages/ui/test/browser/manual-review/pending/plugin-ui-launcher.test.mjs",
  "packages/ui/test/browser/manual-review/pending/plugin-update-all.test.mjs",
  "packages/ui/test/browser/manual-review/pending/preview-card-actions.test.mjs",
  "packages/ui/test/browser/manual-review/pending/project-device-visibility.test.mjs",
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
    if (upstreamVerbatimSuites.has(relativePath)) continue;
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
