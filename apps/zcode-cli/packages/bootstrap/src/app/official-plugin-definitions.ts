import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

// Store-info seed for built-in plugins (written verbatim into the official marketplace.json
// entry raw, with keys matching the CDN directory schema: displayName_i18n /
// examplePrompts_i18n etc.); parsing reuses the adapter's parseEntryStoreListing. Icons point
// at the official assets CDN; on request failure the UI safely degrades to the default icon.
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

export const OFFICIAL_BROWSER_USE_PLUGIN_NAME = "browser-use";
export const OFFICIAL_BROWSER_USE_PLUGIN_ID = `${OFFICIAL_BROWSER_USE_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
/**
 * The node_repl host. Not a user-facing plugin: no skill, no listing, not in the market; its
 * sole job is carrying the `dist/mcp/server.js` runtime artifact shared by Browser Use and Computer Use.
 *
 * Why it must be its own seed unit: the host artifact used to live inside the browser-use
 * package, so resolveBuiltInNodeReplMcpServers could only find it under browser-use's rootPath —
 * with that package absent, even Computer Use itself enabled could not get the host. As its own
 * seed unit, the two plugins each contribute only their own domain assets, and whichever is
 * enabled gets the same host.
 */
export const OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME = "node-repl-host";
export const OFFICIAL_NODE_REPL_HOST_PLUGIN_ID = `${OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
export const OFFICIAL_CUA_PLUGIN_NAME = "computer-use";
export const OFFICIAL_CUA_PLUGIN_ID = `${OFFICIAL_CUA_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

export interface OfficialPluginDefinition {
  /**
   * Recoverable entries after uninstall (suppression) carry no runtime info; the store can only
   * decide "UI plugin" membership from this. A package manifest declaring ui.surfaces must also
   * declare "ui" — bootstrap tests verify the two agree.
   */
  componentTypes?: readonly string[];
  // A content-only plugin (no MCP server / no system dependencies) may set this true,
  // so the user's first `/skill <name>` just works without `zcode plugins enable` first.
  // Default false keeps heavy plugins like ios-simulator / android-emulator on their old behavior.
  defaultEnabled?: boolean;
  listing?: OfficialPluginListingSeed;
  /**
   * MCP servers provided by the host for this official plugin but not part of the plugin manifest.
   * Used only for product attribution and settings-page status display; at runtime the host identity remains.
   */
  hostMcpServerNames?: readonly string[];
  name: string;
  /** Reject generating a partial official plugin cache when the filesystem/SEA seed is missing any entry. */
  requiredSeedPaths?: readonly string[];
  rootCandidates: readonly string[];
  /** Extra top-level paths intentionally staged as plugin runtime assets. */
  runtimeTopLevelPaths?: readonly string[];
  version: string;
}

const ZAI_AUTHOR = { name: "Z.ai", url: "https://z.ai" } as const;
const OFFICIAL_PLUGIN_ASSETS_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/assets";

export const OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS = ["dist/mcp/server.js"] as const;

/** Build artifacts of the document plugins' (documents / pdf / presentations / spreadsheets) viewer panel. */
export const OFFICIAL_OFFICE_VIEWER_RUNTIME_PATHS = [
  "dist/server.mjs",
  "dist/ui/assets.json",
  "dist/ui/panel.html",
] as const;

export const OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS = [
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json already registers the recording lookup; without enforcing body validation it would seed a broken plugin that cannot read the screen-recording guide.
  "docs/recording.md",
  "docs/workflow.md",
  "scripts/browser-client.mjs",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
] as const;

export const OFFICIAL_CUA_REQUIRED_SEED_PATHS = [
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
] as const;

// Root cause (2026-08-24): zcode-guide had no requiredSeedPaths, so a seed that lost files
// silently installed a broken plugin with no diagnostics. Since 0.3.0 the `/workflow` command
// and dynamic-workflows skills no longer ship with this plugin (the command is compiled into
// the CLI, the skills moved to packages/bundled-skills, see
// docs/dynamic-workflow/authoring.md); what is pinned here is the configuration-guide skill body.
export const OFFICIAL_ZCODE_GUIDE_REQUIRED_SEED_PATHS = [
  "skills/zcode-configuration-guide/SKILL.md",
] as const;

export const OFFICIAL_PLUGIN_DEFINITIONS: readonly OfficialPluginDefinition[] = [
  {
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Visualize",
      displayName_i18n: { "zh-CN": "交互视图" },
      description_i18n: { "zh-CN": "在对话中创建交互图表、解释和设计预览。" },
    },
    name: "visualize",
    requiredSeedPaths: [
      "skills/visualize/SKILL.md",
      "skills/visualize/references/api.md",
      "skills/visualize/references/styles.md",
      "skills/visualize/tweak.md",
      "skills/visualize/LICENSE.md",
      "skills/visualize/scripts/render.py",
      "skills/visualize/assets/visualize.css",
      "skills/visualize/assets/visualize.html",
      "skills/visualize/assets/calendar.js",
      "skills/visualize/assets/runtime-manifest.json",
      "skills/visualize/scripts/vendor.py",
      "skills/visualize/assets/vendor/manifest.json",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
      "skills/visualize/assets/vendor/lucide-1.17.0.js",
      "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
      "skills/visualize/widgets/calendar.md",
      "skills/visualize/examples/calendar.html",
      "skills/visualize/assets/standalone-host-bridge.js",
      "skills/visualize/assets/standalone-shell.js",
    ],
    rootCandidates: [
      "packages/visualize-plugin",
      "../visualize-plugin",
      "../../visualize-plugin",
      "../../../visualize-plugin",
    ],
    version: "0.1.1",
  },
  {
    // No listing: the host never enters the market or surfaces to users. It must always be
    // available because node_repl's registration gate is "Browser Use or Computer Use enabled";
    // the host itself takes no part in that check.
    //
    // defaultEnabled here does not violate the "content-only plugins" rule (see the computer-use
    // note below): what the rule guards against is "inject the whole toolset on first launch and
    // start the Helper" — the seed host does neither. Whether tools enter the model tool pool is
    // decided by the two capability plugins' enablement, and the Helper starts only on first SDK call.
    defaultEnabled: true,
    name: OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
    requiredSeedPaths: OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/node-repl-host",
      "../node-repl-host",
      "../../node-repl-host",
      "../../../node-repl-host",
    ],
    version: "0.7.0",
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
    // The manifest declares only the browser-use skill; the host node_repl MCP is injected
    // separately, and the package additionally carries its server/client runtime assets. Default
    // enablement controls only the "when/how to use the built-in browser" skill and browser bridge.
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
    // If the official seed version is missed when the package/manifest bumps, the old cache directory keeps loading.
    // package, manifest, and definition versions should stay in sync so shipped content and installed version do not fork again.
    version: "0.5.1",
  },
  ...(
    [
      // Versions bump per plugin and swap in a new cache directory: from pdf 0.2.1 the panel has
      // CJK font fallback; from 0.2.1 (pdf 0.2.2) the server is shared by all sessions in the
      // workspace — the old cache's session-agnostic server cannot be reused.
      ["documents", "docx", "Documents", "Word文档", "0.2.1"],
      ["pdf", "pdf", "PDF", "PDF", "0.2.2"],
      ["presentations", "pptx", "Presentations", "演示文档", "0.2.1"],
      ["spreadsheets", "xlsx", "Spreadsheets", "电子表格", "0.2.1"],
    ] as const
  ).map(
    ([name, skill, displayName, chineseName, version]): OfficialPluginDefinition => ({
      componentTypes: ["ui"],
      defaultEnabled: true,
      listing: {
        author: ZAI_AUTHOR,
        category: "productivity",
        displayName,
        displayName_i18n: { "zh-CN": chineseName },
        // Reuse the already-published document icons so the split plugins need no new CDN assets.
        icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/document-skills/icon.png`,
        description_i18n: { "zh-CN": `创建、编辑与审阅${chineseName}（${skill.toUpperCase()}）。` },
      },
      name,
      // Since 0.2.0 the document plugins also provide a viewer panel: the MCP server and panel
      // assets are built into dist/ by office-runtime; missing either would seed a broken plugin
      // whose panel entry is visible but cannot start.
      requiredSeedPaths: [
        "agents/visual-judge.md",
        `skills/${skill}/SKILL.md`,
        `skills/${skill}-viewer/SKILL.md`,
        ...OFFICIAL_OFFICE_VIEWER_RUNTIME_PATHS,
      ],
      rootCandidates: [
        `packages/${name}-plugin`,
        `../${name}-plugin`,
        `../../${name}-plugin`,
        `../../../${name}-plugin`,
      ],
      version,
    }),
  ),
  {
    // Keeps the original aggregated document plugin's official image-search capability, split into its own toggle; auth is still injected by the official MCP adapter.
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
      // The creator uses the client's bundled icon instead of borrowing skill-creator's remote image.
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
    // Declaration-only plugin: it ships an inline lspServers entry and no skills, commands, or MCP.
    // The language server binary is not bundled; the entry stays inert until typescript-language-server
    // is on PATH (see the plugin README). Keep packages/shared/src/plugin-marketplaces.ts in sync.
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "developer-tools",
      displayName: "TypeScript LSP",
      description_i18n: {
        "zh-CN": "为 TypeScript 与 JavaScript 文件提供语言服务器，支持编辑后诊断。",
      },
    },
    name: "typescript-lsp",
    rootCandidates: [
      "packages/typescript-lsp-plugin",
      "../typescript-lsp-plugin",
      "../../typescript-lsp-plugin",
      "../../../typescript-lsp-plugin",
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
    version: "0.3.0",
  },
  {
    // Product decision: computer use falls back to default-off and requires an explicit opt-in
    // on the settings page. Hence no defaultEnabled here — computer-use carries an MCP server
    // and system Helper dependencies, and default-on would inject the whole toolset and start
    // the Helper on every new user's first launch.
    // The old "defaultEnabled is for content-only plugins" rule is thereby fully restored.
    // The decision expression is enabledPlugins[id] ?? defaultEnabled: users who once manually
    // enabled it in settings already have an explicit true persisted and are unaffected by this
    // default change. Reverting to default-on requires syncing
    // packages/shared/src/plugin-marketplaces.ts (bootstrap unit tests mechanically compare the
    // two), isZCodeCuaInternalFeatureEnabled (packaging layer defaults true), and the linked
    // semantics of the input-box entry's hidden default.
    name: "computer-use",
    hostMcpServerNames: ["node_repl"],
    // The user-facing name is unified as "Computer Use". The package and producer workspace
    // package stay zcode-cua for native Helper identity compatibility; the EN description
    // baseline comes from the manifest description, so only the zh-CN override lives here;
    // resolveLocalizedText falls back to the manifest under en-US.
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Computer Use",
      displayName_i18n: { "zh-CN": "电脑控制" },
      description_i18n: {
        "zh-CN": "自动化桌面应用：智能体驱动鼠标、键盘与界面元素，代你完成实际任务。",
      },
      // After the plugin rename to computer-use, the CDN icon is still published under the zcode-cua directory; keep the asset path to avoid 404s.
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/zcode-cua/icon.png`,
    },
    rootCandidates: [
      "packages/zcode-cua-plugin",
      "../zcode-cua-plugin",
      "../../zcode-cua-plugin",
      "../../../zcode-cua-plugin",
    ],
    requiredSeedPaths: OFFICIAL_CUA_REQUIRED_SEED_PATHS,
    // Bug root cause: the node_repl migration also cut the legacy MCP launcher and the Sharp
    // runtime still needed by the SDK. Dev/desktop stages the minimal Sharp closure here; the
    // official cache must keep carrying node_modules, or the first screenshot after the seed's
    // atomic replacement reports Cannot find module 'sharp'.
    runtimeTopLevelPaths: ["node_modules"],
    // This version tracks the upstream zcode-cua runtime version so the plugin UI display,
    // cache path, and marketplace entry stay aligned; the actual bump is maintained by the
    // atomic producer bump workflow.
    version: "0.6.5",
  },
  {
    // ZCode Sites (technical plan 4): a Skill-guided Agent converts the project into an artifact
    // package the runner can execute directly, then uploads it via scripts/zcode-site.mjs (CLI);
    // commands/ holds the /site-* slash commands.
    // Since 0.4.0 it ships a Sites panel (UI plugin): the MCP server and panel pages are built
    // into dist/ for the panel only — invisible to the model (docs/site/sites-panel.md). Enabled
    // by default so users can have the Agent deploy a site without first toggling it in settings.
    componentTypes: ["ui"],
    name: "zcode-site",
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "ZCode Sites",
      displayName_i18n: { "zh-CN": "ZCode Sites" },
      description_i18n: {
        "zh-CN": "把 Web 项目改造为可在云端 Linux 运行的部署包，一个 start.sh 即可启动。",
      },
      examplePrompts: ["Deploy this project as a website"],
      examplePrompts_i18n: { "zh-CN": ["把这个项目部署成网站"] },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/zcode-site/icon.png`,
    },
    rootCandidates: [
      "packages/zcode-site-plugin",
      "../zcode-site-plugin",
      "../../zcode-site-plugin",
      "../../../zcode-site-plugin",
    ],
    requiredSeedPaths: [
      "commands/site-deploy.md",
      "scripts/zcode-site.mjs",
      "scripts/stage.mjs",
      "skills/site-deploy/SKILL.md",
      "skills/site-deploy/templates/static.sh",
      "skills/site-deploy/templates/static-server.mjs",
      "skills/site-deploy/templates/node.sh",
      "skills/site-deploy/templates/python.sh",
      // Missing either would seed a broken plugin whose panel entry is visible but whose MCP server cannot start.
      "dist/server.mjs",
      "dist/ui/panel.html",
    ],
    version: "0.4.2",
  },
];

// Plugins marked defaultEnabled: true in the official plugin definitions, joined as
// `<name>@<marketplace>` and passed through to the adapter so it enables them by default when
// the user has no explicit config (content-only plugins only).
// Note: every plugin-resolution entry point (CLI subcommand resolveZCodePlugins, app startup
// resolveStartupPlugins) must pass this set to discoverNodePluginsSync, or defaultEnabled has no effect.
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
 * MCP servers injected by the host CLI for official plugins (e.g. browser-use's `node_repl`)
 * carry no `plugin:` prefix in their server name; attributing resources to a plugin requires
 * reverse-looking-up the owning official plugin name.
 */
export function resolveOfficialPluginNameByHostMcpServerName(
  serverName: string,
): string | undefined {
  return OFFICIAL_PLUGIN_DEFINITIONS.find((definition) =>
    definition.hostMcpServerNames?.includes(serverName),
  )?.name;
}
