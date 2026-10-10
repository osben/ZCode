import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

// Store metadata seeds for built-in plugins (raw marketplace.json entries written to
// the official marketplace unchanged, with keys matching the CDN directory schema such
// as displayName_i18n / examplePrompts_i18n). Reuse the adapter's parseEntryStoreListing
// for parsing. Icons point to the official assets CDN; if a request fails, the UI safely
// falls back to its default icon.
export interface OfficialPluginListingSeed {
  displayName?: string;
  displayName_i18n?: Record<string, string>;
  description_i18n?: Record<string, string>;
  category?: string;
  author?: { name: string; url?: string };
  icon?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  heroImage?: string;
  examplePrompts?: string[];
  examplePrompts_i18n?: Record<string, string[]>;
}

const OFFICIAL_BROWSER_USE_PLUGIN_NAME = "browser-use";
export const OFFICIAL_BROWSER_USE_PLUGIN_ID = `${OFFICIAL_BROWSER_USE_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
/**
 * node_repl host. It is not a user-facing plugin: it has no skill or listing and is not
 * included in the marketplace. Its only job is to carry `dist/mcp/server.js`, the
 * runtime artifact shared by Browser Use and Computer Use.
 *
 * Why it needs to be a separate seed unit: the host artifact used to live in the
 * browser-use package, so resolveBuiltInNodeReplMcpServers could only find it under
 * browser-use's rootPath. If that package was missing, Computer Use could not get the
 * host even when enabled. As a separate seed unit, each plugin contributes only its own
 * domain assets, and either can use the same host.
 */
export const OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME = "node-repl-host";
export const OFFICIAL_NODE_REPL_HOST_PLUGIN_ID = `${OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
const OFFICIAL_CUA_PLUGIN_NAME = "computer-use";
export const OFFICIAL_CUA_PLUGIN_ID = `${OFFICIAL_CUA_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

export interface OfficialPluginDefinition {
  // Content-only plugins (no MCP server / system dependency) can set this to true so
  // users can run `/skill <name>` the first time without first running `zcode plugins enable`.
  // Default false preserves existing behavior for heavyweight plugins such as ios-simulator / android-emulator.
  defaultEnabled?: boolean;
  listing?: OfficialPluginListingSeed;
  /**
   * MCP server supplied by the host for this official plugin but not part of the plugin
   * manifest. Used only for product ownership and settings-page status; runtime identity
   * remains the host's.
   */
  hostMcpServerNames?: readonly string[];
  name: string;
  /** Reject creation of an incomplete official-plugin cache when any filesystem/SEA seed item is missing. */
  requiredSeedPaths?: readonly string[];
  rootCandidates: readonly string[];
  /** Extra top-level paths intentionally staged as plugin runtime assets. */
  runtimeTopLevelPaths?: readonly string[];
  version: string;
}

const ZAI_AUTHOR = { name: "Z.ai", url: "https://z.ai" } as const;
const OFFICIAL_PLUGIN_ASSETS_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/assets";

const OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS = ["dist/mcp/server.js"] as const;

export const OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS = [
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json registers the recording lookup; without validating its contents, a seed could produce an incomplete plugin whose recording guide cannot be read.
  "docs/recording.md",
  "docs/workflow.md",
  "scripts/browser-client.mjs",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
] as const;

const OFFICIAL_CUA_REQUIRED_SEED_PATHS = [
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
] as const;

// zcode-guide previously had no requiredSeedPaths, so a missing seed file silently
// installed a plugin without the /workflow command. The symptom was a missing command
// with no diagnostic. Pin both commands/ and the skill content.
const OFFICIAL_ZCODE_GUIDE_REQUIRED_SEED_PATHS = [
  "commands/workflow.md",
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/examples.md",
  "skills/dynamic-workflows/patterns.md",
] as const;

export const OFFICIAL_PLUGIN_DEFINITIONS: readonly OfficialPluginDefinition[] = [
  {
    // No listing: the host is not in the marketplace and is not shown to users. It must
    // always be available because node_repl registration is gated by either Browser Use
    // or Computer Use being enabled; the host itself does not participate in that check.
    //
    // defaultEnabled here does not violate the “content-only plugins” rule (see the
    // computer-use note below): that rule prevents injecting a full toolset and launching
    // a Helper on first startup. This seed host does neither. The two capability plugins
    // determine whether tools enter the model tool pool, and the SDK launches Helper only
    // on the first call.
    defaultEnabled: true,
    name: OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
    requiredSeedPaths: OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/node-repl-host",
      "../node-repl-host",
      "../../node-repl-host",
      "../../../node-repl-host",
    ],
    version: "0.6.0",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "developer-tools",
      displayName: "Android Emulator",
      displayName_i18n: { "zh-CN": "Android 模拟器" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/android-emulator/icon.png`,
      description_i18n: {
        "zh-CN": "提供 Android 开发工作流与模拟器自动化能力。",
      },
    },
    name: "android-emulator",
    rootCandidates: [
      "packages/android-emulator-plugin",
      "../android-emulator-plugin",
      "../../android-emulator-plugin",
      "../../../android-emulator-plugin",
    ],
    version: "0.1.0",
  },
  {
    // The manifest declares only the browser-use skill; the host injects node_repl MCP
    // separately, and the package also carries its server/client runtime assets. Default
    // enabled controls only the skill and browser bridge for when/how to use the built-in browser.
    defaultEnabled: true,
    hostMcpServerNames: ["node_repl"],
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Browser Use",
      displayName_i18n: { "zh-CN": "浏览器操作" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/browser-use/icon.png`,
      description_i18n: {
        "zh-CN": "操作 ZCode 内置浏览器，检查网页并验证交互。",
      },
    },
    name: OFFICIAL_BROWSER_USE_PLUGIN_NAME,
    requiredSeedPaths: OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/browser-use-plugin",
      "../browser-use-plugin",
      "../../browser-use-plugin",
      "../../../browser-use-plugin",
    ],
    // If the official seed version is not updated with the plugin package/manifest, the
    // old cache directory will continue to load. Keep package, manifest, and definition
    // versions aligned so published content and installed versions do not diverge again.
    version: "0.5.1",
  },
  ...(
    [
      ["documents", "docx", "Documents", "Word文档"],
      ["pdf", "pdf", "PDF", "PDF"],
      ["presentations", "pptx", "Presentations", "演示文档"],
      ["spreadsheets", "xlsx", "Spreadsheets", "电子表格"],
    ] as const
  ).map(
    ([name, skill, displayName, chineseName]): OfficialPluginDefinition => ({
      defaultEnabled: true,
      listing: {
        author: ZAI_AUTHOR,
        category: "productivity",
        displayName,
        displayName_i18n: { "zh-CN": chineseName },
        // Reuse the published document icon; the split-out plugin does not need a new CDN asset.
        icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/document-skills/icon.png`,
        description_i18n: { "zh-CN": `创建、编辑与审阅${chineseName}（${skill.toUpperCase()}）。` },
      },
      name,
      requiredSeedPaths: ["agents/visual-judge.md", `skills/${skill}/SKILL.md`],
      rootCandidates: [
        `packages/${name}-plugin`,
        `../${name}-plugin`,
        `../../${name}-plugin`,
        `../../../${name}-plugin`,
      ],
      version: "0.1.7",
    }),
  ),
  {
    // Reuse the original aggregate document plugin's official image search capability,
    // exposing only a separate toggle; authentication is still injected by the official MCP adapter.
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Image Search",
      displayName_i18n: { "zh-CN": "搜图" },
      description_i18n: { "zh-CN": "查找插图与参考配图。" },
    },
    name: "image-search",
    requiredSeedPaths: [".mcp.json"],
    rootCandidates: [
      "packages/image-search-plugin",
      "../image-search-plugin",
      "../../image-search-plugin",
      "../../../image-search-plugin",
    ],
    version: "0.1.1",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "developer-tools",
      displayName: "iOS Simulator",
      displayName_i18n: { "zh-CN": "iOS 模拟器" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/ios-simulator/icon.png`,
      description_i18n: {
        "zh-CN": "提供 iOS 开发工作流与模拟器自动化能力。",
      },
    },
    name: "ios-simulator",
    rootCandidates: [
      "packages/ios-simulator-plugin",
      "../ios-simulator-plugin",
      "../../ios-simulator-plugin",
      "../../../ios-simulator-plugin",
    ],
    version: "0.1.0",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Restore Legacy Sessions",
      displayName_i18n: { "zh-CN": "恢复旧版会话" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/restore-legacy-sessions/icon.png`,
      description_i18n: {
        "zh-CN": "将旧版会话恢复为 ZCode 任务与会话记录。",
      },
    },
    name: "restore-legacy-sessions",
    rootCandidates: [
      "packages/restore-legacy-sessions-plugin",
      "../restore-legacy-sessions-plugin",
      "../../restore-legacy-sessions-plugin",
      "../../../restore-legacy-sessions-plugin",
    ],
    version: "0.1.0",
  },
  {
    defaultEnabled: true,
    name: "plugin-creator",
    version: "0.1.1",
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Plugin Creator",
      // The creator uses its built-in client icon instead of borrowing the remote image from skill-creator.
      displayName_i18n: { "zh-CN": "插件创建器" },
      description_i18n: {
        "zh-CN": "开发、校验 ZCode 插件，完成本地 dev 市场安装、试用与更新。",
      },
    },
    rootCandidates: [
      "packages/plugin-creator-plugin",
      "../plugin-creator-plugin",
      "../../plugin-creator-plugin",
      "../../../plugin-creator-plugin",
    ],
    requiredSeedPaths: [
      "skills/plugin-creator/SKILL.md",
      "skills/plugin-creator/scripts/create-basic-plugin.mjs",
      "skills/plugin-creator/scripts/marketplace-files.mjs",
      "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
      "skills/plugin-creator/scripts/scaffold-files.mjs",
      "skills/plugin-creator/scripts/validate-plugin.mjs",
      "skills/plugin-creator/references/plugin-json-spec.md",
      "skills/plugin-creator/references/installing-and-updating.md",
    ],
  },
  {
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Skill Creator",
      displayName_i18n: { "zh-CN": "技能创建器" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/skill-creator/icon.png`,
      description_i18n: { "zh-CN": "创建、编辑和验证可复用的 ZCode 技能。" },
    },
    name: "skill-creator",
    rootCandidates: [
      "packages/skill-creator-plugin",
      "../skill-creator-plugin",
      "../../skill-creator-plugin",
      "../../../skill-creator-plugin",
    ],
    version: "0.1.0",
  },
  {
    // Content-only plugin (commands + skills, no MCP / system dependencies), enabled by
    // default so users/agents have the ZCode configuration guide, self-diagnostic skill,
    // and dynamic-workflow authoring guide out of the box.
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "ZCode Guide",
      displayName_i18n: { "zh-CN": "ZCode 使用指南" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/zcode-guide/icon.png`,
      description_i18n: {
        "zh-CN": "提供 ZCode 配置指南与插件、技能、MCP、命令和钩子诊断。",
      },
      examplePrompts: [
        "How do I configure MCP servers in ZCode?",
        "Diagnose my current ZCode setup",
      ],
      examplePrompts_i18n: {
        "zh-CN": ["ZCode 里怎么配置 MCP 服务器？", "帮我诊断当前的 ZCode 配置"],
      },
    },
    name: "zcode-guide",
    requiredSeedPaths: OFFICIAL_ZCODE_GUIDE_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/zcode-guide-plugin",
      "../zcode-guide-plugin",
      "../../zcode-guide-plugin",
      "../../../zcode-guide-plugin",
    ],
    version: "0.2.0",
  },
  {
    // Product decision: computer control returns to disabled by default and must be
    // explicitly enabled in settings. Do not declare defaultEnabled here: computer-use
    // includes an MCP server and system Helper dependency, so enabling it by default
    // would inject the full toolset and launch Helper on every new user's first startup.
    // This restores the original rule that only content-only plugins may be
    // defaultEnabled. The check is enabledPlugins[id] ?? defaultEnabled; users who
    // previously enabled it in settings have an explicit persisted true and are
    // unaffected. If default-enabled behavior is restored, also update the list in
    // packages/shared/src/plugin-marketplaces.ts (bootstrap tests compare them),
    // isZCodeCuaInternalFeatureEnabled (packaging defaults to true), and the linked
    // hidden-by-default behavior of the input entry point.
    name: "computer-use",
    hostMcpServerNames: ["node_repl"],
    // The user-facing name is consistently “Computer Use / 电脑控制”. Keep the package
    // name and producer repository as zcode-cua to preserve native Helper identity. The
    // manifest description is the English baseline; this entry contains only a zh-CN
    // override, and resolveLocalizedText falls back to the manifest for en-US.
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Computer Use",
      displayName_i18n: { "zh-CN": "电脑控制" },
      description_i18n: {
        "zh-CN": "自动化桌面应用：智能体驱动鼠标、键盘与界面元素，代你完成实际任务。",
      },
      // After the plugin was renamed to computer-use, the CDN icon remained under zcode-cua; reuse that path to avoid 404s.
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/zcode-cua/icon.png`,
    },
    rootCandidates: [
      "packages/zcode-cua-plugin",
      "../zcode-cua-plugin",
      "../../zcode-cua-plugin",
      "../../../zcode-cua-plugin",
    ],
    requiredSeedPaths: OFFICIAL_CUA_REQUIRED_SEED_PATHS,
    // Current CUA is an unavailable placeholder package and needs no native runtime copy; avoid carrying stale local dependencies into the cache.
    runtimeTopLevelPaths: [],
    // This version tracks the upstream zcode-cua runtime so the plugin UI, cache path,
    // and marketplace entry stay aligned. The atomic producer-bump workflow maintains the exact version.
    version: "0.6.3",
  },
];

// Convert official plugin definitions marked defaultEnabled: true into `<name>@<marketplace>`
// values and pass them to the adapter, which enables them by default when the user has no
// explicit setting (for content-only plugins only).
// Every plugin-resolution entry point (CLI command resolveZCodePlugins and app startup
// resolveStartupPlugins) must pass this set to discoverNodePluginsSync, or defaultEnabled
// will not take effect.
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set(
  OFFICIAL_PLUGIN_DEFINITIONS.filter((definition) => definition.defaultEnabled).map(
    (definition) => `${definition.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
  ),
);

export function resolveOfficialPluginHostMcpServerNames(pluginId: string): string[] {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(
    (candidate) => `${candidate.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}` === pluginId,
  );
  return definition?.hostMcpServerNames ? [...definition.hostMcpServerNames] : [];
}

/**
 * MCP servers injected by the host CLI for official plugins (such as browser-use's
 * `node_repl`) have no `plugin:` prefix in their server name. The resource manager uses
 * this to look up the owning official plugin.
 */
export function resolveOfficialPluginNameByHostMcpServerName(
  serverName: string,
): string | undefined {
  return OFFICIAL_PLUGIN_DEFINITIONS.find((definition) =>
    definition.hostMcpServerNames?.includes(serverName),
  )?.name;
}
