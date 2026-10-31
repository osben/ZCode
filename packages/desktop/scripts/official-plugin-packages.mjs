// Official plugin packages staged into the agent node bundle (split out of prepare-agent-node-bundle.mjs
// to keep that script under the max-lines limit).
// stage-agent-bundle.mjs resolves the destinations for zcode.cjs and .node-bundle-meta.json itself.
// After the node_repl host moved into the separate @zcode/node-repl-host package, browser-use stopped
// producing dist/mcp/server.js. The CUA assets (docs/computer-use.md and scripts/computer-use-client.mjs)
// also moved to @zcode/zcode-cua-plugin. This list was not updated, so packaging still requested those
// three files from browser-use and failed with a missing runtime. The dev path uses the corrected
// requiredDevPluginRuntimeBuilds in scripts/build-desktop-agent-cli.mjs. These parallel lists are
// maintained separately, so dev testing does not catch the packaging issue; see the authoritative
// ownership in bootstrap/official-plugin-definitions.ts.
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json now exposes recording lookup, so the desktop package cannot reuse a runtime that
  // omits the document contents.
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];

// The viewer panels of the document plugins (documents / pdf / presentations / spreadsheets) are built
// into each plugin's dist/ by the shared @zcode/office-runtime package; the plugin packages have no TypeScript source.
const officeViewerRuntimePaths = ["dist/server.mjs", "dist/ui/assets.json", "dist/ui/panel.html"];

export const officialPluginPackages = [
  {
    packageName: "@zcode/android-emulator-plugin",
    relativePath: "apps/zcode-cli/packages/android-emulator-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build-mcp.mjs",
    stagedPath: "packages/android-emulator-plugin",
  },
  {
    packageName: "@zcode/documents-plugin",
    relativePath: "apps/zcode-cli/packages/documents-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/docx/SKILL.md",
      "skills/docx-viewer/SKILL.md",
    ],
    runtimeBuildScript: "../office-runtime/scripts/build.mjs",
    stagedPath: "packages/documents-plugin",
  },
  {
    packageName: "@zcode/image-search-plugin",
    relativePath: "apps/zcode-cli/packages/image-search-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [".mcp.json"],
    stagedPath: "packages/image-search-plugin",
  },
  {
    packageName: "@zcode/pdf-plugin",
    relativePath: "apps/zcode-cli/packages/pdf-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/pdf/SKILL.md",
      "skills/pdf-viewer/SKILL.md",
    ],
    runtimeBuildScript: "../office-runtime/scripts/build.mjs",
    stagedPath: "packages/pdf-plugin",
  },
  {
    packageName: "@zcode/presentations-plugin",
    relativePath: "apps/zcode-cli/packages/presentations-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/pptx/SKILL.md",
      "skills/pptx-viewer/SKILL.md",
    ],
    runtimeBuildScript: "../office-runtime/scripts/build.mjs",
    stagedPath: "packages/presentations-plugin",
  },
  {
    packageName: "@zcode/spreadsheets-plugin",
    relativePath: "apps/zcode-cli/packages/spreadsheets-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: officeViewerRuntimePaths,
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/xlsx/SKILL.md",
      "skills/xlsx-viewer/SKILL.md",
    ],
    runtimeBuildScript: "../office-runtime/scripts/build.mjs",
    stagedPath: "packages/spreadsheets-plugin",
  },
  {
    packageName: "@zcode/visualize-plugin",
    relativePath: "apps/zcode-cli/packages/visualize-plugin",
    requiresRuntime: false,
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
    requiredRuntimePaths: [],
    stagedPath: "packages/visualize-plugin",
  },
  {
    // browser-use carries only its client script and skills/docs; the node_repl MCP runtime belongs to
    // @zcode/node-repl-host (see the constant comment above).
    packageName: "@zcode/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },
  {
    packageName: "@zcode/ios-simulator-plugin",
    relativePath: "apps/zcode-cli/packages/ios-simulator-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build-mcp.mjs",
    stagedPath: "packages/ios-simulator-plugin",
  },
  {
    // Fix rationale: restore-legacy-sessions is registered as an official plugin, but the Electron
    // production package copies only the resources listed here. Omitting it keeps the plugin out of
    // plugins list after the production package's first launch.
    packageName: "@zcode/restore-legacy-sessions-plugin",
    relativePath: "apps/zcode-cli/packages/restore-legacy-sessions-plugin",
    requiresRuntime: false,
    stagedPath: "packages/restore-legacy-sessions-plugin",
  },
  {
    packageName: "@zcode/skill-creator-plugin",
    relativePath: "apps/zcode-cli/packages/skill-creator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/skill-creator-plugin",
  },
  {
    packageName: "@zcode/typescript-lsp-plugin",
    relativePath: "apps/zcode-cli/packages/typescript-lsp-plugin",
    requiresRuntime: false,
    stagedPath: "packages/typescript-lsp-plugin",
  },
  {
    packageName: "@zcode/plugin-creator-plugin",
    relativePath: "apps/zcode-cli/packages/plugin-creator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/plugin-creator-plugin",
  },
  {
    // Fix rationale: zcode-guide is registered as an official default-enabled content plugin (see
    // official-plugin-definitions.ts). The Electron production package does not take the SEA path;
    // official plugin seeding relies on the resources/glm/packages/*-plugin staged here. Omitting it
    // means the production desktop package cannot seed the plugin on first launch, and users lose the
    // default-enabled configuration guide skill.
    packageName: "@zcode/zcode-guide-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-guide-plugin",
    requiresRuntime: false,
    stagedPath: "packages/zcode-guide-plugin",
  },
  {
    // node_repl host: the MCP runtime shared by Browser Use and Computer Use, now in a separate package.
    // It has no listing and does not appear in the plugin marketplace, but first-run seeding in the
    // production package needs its dist runtime. Otherwise node_repl is unavailable when either bua or
    // cua is enabled.
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
  {
    // The CUA plugin carries only its SDK/skills/docs; the node_repl MCP runtime belongs to
    // @zcode/node-repl-host.
    packageName: "@zcode/zcode-cua-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-cua-plugin",
    requiresRuntime: false,
    stagedPath: "packages/zcode-cua-plugin",
  },
  // superpowers has been retired from bundled plugins and is now installed on demand from the UI
  // recommendations section; its resources are no longer staged here.
  {
    packageName: "@zcode/zcode-site-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-site-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/server.mjs", "dist/ui/panel.html"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/zcode-site-plugin",
  },
];
