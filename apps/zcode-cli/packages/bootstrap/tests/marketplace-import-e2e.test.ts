// E2E: verify the real agent path reached by the "custom marketplace import" latest commit
// (feat: add custom marketplace source import popover).
//
// UI-side path: AddMarketplacePopover -> PluginsSection.onAddMarketplace
//   -> pluginManagementStore.addMarketplace(source) -> agentService.addPluginMarketplace
//   -> protocol plugins/marketplace/add -> server.ts dispatch -> the facade verified in this file.
//
// This test drives the agent-side facade addZCodePluginMarketplace directly, feeding it the "free-text string"
// the popover passes down verbatim, covering parseMarketplaceSourceInput -> loadMarketplaceFromSource (reads the
// manifest / real git clone) -> persistence, then re-checks with getZCodePluginsOverview (equivalent to the UI
// refresh seeing the new marketplace after the popover closes).
// Each case uses its own isolated temporary storageRoot. GitHub cases probe reachability first and skip when
// unreachable instead of failing by mistake.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { addZCodePluginMarketplace, getZCodePluginsOverview } from "../src/plugins.js";

const execFileAsync = promisify(execFile);

// Popover call contract: source is free text; in the real runtime pluginStorageRoot is derived from the config,
// here it is explicitly overridden to a temp directory for isolation — equivalent to "import in a fresh workspace".
function addViaFacade(source: string, storageRoot: string, workingDirectory: string) {
  return addZCodePluginMarketplace({
    source,
    pluginStorageRoot: storageRoot,
    workingDirectory,
    skipUserConfig: true,
  });
}

function overview(storageRoot: string, workingDirectory: string) {
  return getZCodePluginsOverview({
    pluginStorageRoot: storageRoot,
    workingDirectory,
    skipUserConfig: true,
  });
}

async function makeLocalMarketplace(root: string, name: string): Promise<void> {
  const pluginDir = join(root, "plugins", "hello");
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await mkdir(join(pluginDir, "skills", "hello"), { recursive: true });
  await writeFile(
    join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      { name, plugins: [{ name: "hello", version: "1.0.0", source: "./plugins/hello" }] },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "hello", version: "1.0.0", skills: "skills" }, null, 2),
  );
  await writeFile(join(pluginDir, "skills", "hello", "SKILL.md"), "# hello\n");
}

async function githubReachable(repoHttps: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-remote", "--heads", repoHttps], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

describe("marketplace 自定义导入 E2E (真实 agent facade)", () => {
  it("本地目录导入：raw 目录路径 -> directory 来源 -> 落盘 + overview 可见", async () => {
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-localdir-"));
    const storageRoot = join(base, "storage");
    const market = join(base, "my-local-market");
    try {
      await makeLocalMarketplace(market, "e2e-local-dir-market");

      // The popover passes the directory path as source directly (unstructured).
      const summary = await addViaFacade(market, storageRoot, base);
      expect(summary.id).toBe("e2e-local-dir-market");
      expect(summary.pluginCount).toBe(1);

      const knownPath = join(storageRoot, "known_marketplaces.json");
      expect(existsSync(knownPath)).toBe(true);
      const known = JSON.parse(await readFile(knownPath, "utf8")) as {
        marketplaces: Array<{ id: string; source: { source: string; path?: string } }>;
      };
      const rec = known.marketplaces.find((m) => m.id === "e2e-local-dir-market");
      expect(rec?.source.source).toBe("directory");
      expect(rec?.source.path).toBe(market);

      // The manifest is copied into storage for later install references.
      const manifestCopy = join(storageRoot, "marketplaces", "e2e-local-dir-market", "marketplace.json");
      expect(existsSync(manifestCopy)).toBe(true);

      // Re-check: overview lists the new marketplace (the UI refresh sees it after the popover closes).
      const ov = overview(storageRoot, base);
      expect(ov.marketplaces.some((m) => m.id === "e2e-local-dir-market")).toBe(true);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });

  it("非法来源：facade 抛错（驱动 store 失败分支 -> 返回 false -> popover 保留输入），且不误落盘", async () => {
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-invalid-"));
    const storageRoot = join(base, "storage");
    try {
      // A nonexistent local path typed casually into the popover.
      await expect(addViaFacade("./definitely-not-a-real-marketplace-xyz", storageRoot, base)).rejects.toThrow();
      // known_marketplaces.json must not be written on failure.
      expect(existsSync(join(storageRoot, "known_marketplaces.json"))).toBe(false);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });

  it("GitHub 导入：raw git URL -> git 来源 -> 真实 clone -> 落盘", async () => {
    // Pick a small public repo whose root has .claude-plugin/marketplace.json, avoiding clone timeouts on large repos.
    const repoUrl = "https://github.com/wshobson/agents.git";
    if (!(await githubReachable(repoUrl))) {
      console.warn("[e2e] GitHub 不可达，跳过 git URL clone 用例");
      return;
    }
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-github-"));
    const storageRoot = join(base, "storage");
    try {
      // https .git -> parseMarketplaceSourceInput classifies it as source:"git" -> a real clone --depth 1.
      const summary = await addViaFacade(repoUrl, storageRoot, base);
      // manifest.name is the marketplace id (that repo's manifest is named claude-code-workflows).
      expect(summary.id).toBe("claude-code-workflows");
      expect(summary.pluginCount).toBeGreaterThan(0);

      const known = JSON.parse(await readFile(join(storageRoot, "known_marketplaces.json"), "utf8")) as {
        marketplaces: Array<{ id: string; source: { source: string; url?: string } }>;
      };
      const rec = known.marketplaces.find((m) => m.id === summary.id);
      expect(rec?.source.source).toBe("git");
      expect(rec?.source.url).toBe(repoUrl);

      // The cloned manifest is copied into storage.
      const manifestCopy = join(storageRoot, "marketplaces", summary.id, "marketplace.json");
      expect(existsSync(manifestCopy)).toBe(true);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  }, 120_000);

  it("GitHub 简写导入：raw owner/repo -> github 来源 -> 真实 clone -> 落盘", async () => {
    const repo = "wshobson/agents";
    if (!(await githubReachable(`https://github.com/${repo}.git`))) {
      console.warn("[e2e] GitHub 不可达，跳过 owner/repo 简写用例");
      return;
    }
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-gh-short-"));
    const storageRoot = join(base, "storage");
    try {
      // owner/repo shorthand -> parseMarketplaceSourceInput classifies it as source:"github".
      const summary = await addViaFacade(repo, storageRoot, base);
      expect(summary.id).toBe("claude-code-workflows");

      const known = JSON.parse(await readFile(join(storageRoot, "known_marketplaces.json"), "utf8")) as {
        marketplaces: Array<{ id: string; source: { source: string; repo?: string } }>;
      };
      const rec = known.marketplaces.find((m) => m.id === summary.id);
      expect(rec?.source.source).toBe("github");
      expect(rec?.source.repo).toBe(repo);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  }, 120_000);
});
