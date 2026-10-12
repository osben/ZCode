import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkspaceHookBundleSnapshot,
  discoverWorkspaceHookConfigPaths,
  readWorkspaceHookProjectSources,
} from "../src/workspace-hook-discovery.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hook-dedup-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("workspace hook config discovery 去重（#10）", () => {
  it("explicit path 与 auto-discovery 重叠时只保留一个条目", () => {
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"));
    const configPath = join(workspace, ".zcode", "config.json");
    writeJson(configPath, {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        },
      },
    });

    // Without explicit: auto-discovery finds one file
    const withoutExplicit = discoverWorkspaceHookConfigPaths({
      workingDirectory: workspace,
    });
    expect(withoutExplicit).toHaveLength(1);
    expect(withoutExplicit[0]?.explicitProjectConfig).toBe(false);

    // With explicit pointing at the same file: still one entry after dedup
    const withExplicit = discoverWorkspaceHookConfigPaths({
      workingDirectory: workspace,
      explicitProjectConfigPath: configPath,
    });
    expect(withExplicit).toHaveLength(1);
    // First occurrence (auto-discovered) is kept; the duplicate explicit entry is dropped
    expect(withExplicit[0]?.explicitProjectConfig).toBe(false);
    expect(withExplicit[0]?.path).toBe(configPath);
  });

  it("explicit path 指向 auto-discovery 未发现的文件时正常追加", () => {
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"));
    writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        },
      },
    });

    // explicit points at an additional file
    const extraPath = join(workspace, "custom-config.json");
    writeJson(extraPath, {
      hooks: {
        enabled: true,
        events: {
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
      },
    });

    const refs = discoverWorkspaceHookConfigPaths({
      workingDirectory: workspace,
      explicitProjectConfigPath: extraPath,
    });
    expect(refs).toHaveLength(2);
    expect(refs[0]?.explicitProjectConfig).toBe(false);
    expect(refs[1]?.explicitProjectConfig).toBe(true);
    expect(refs[1]?.path).toBe(extraPath);
  });

  it("无 explicit path 时 discovery 结果不变（digest 稳定性）", async () => {
    // After the dedup logic was introduced, it must be a no-op for workspaces without an explicit path,
    // otherwise changed discoveryOrder from auto-discovery would invalidate all existing trust records.
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"));
    writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        },
      },
    });

    const { sources } = await readWorkspaceHookProjectSources({
      workingDirectory: workspace,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.discoveryOrder).toBe(0);
    expect(sources[0]?.explicitProjectConfig).toBe(false);

    // Build the bundle snapshot and confirm the digest is reproducible (same input, identical result twice)
    const snapshot1 = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources,
      runtimeRoot: { enabled: true, timeoutMs: 60_000, maxOutputBytes: 32_768 },
    });
    const snapshot2 = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources,
      runtimeRoot: { enabled: true, timeoutMs: 60_000, maxOutputBytes: 32_768 },
    });
    expect(snapshot1.bundleDigest).toBe(snapshot2.bundleDigest);
    expect(snapshot1.bundleDigest).toBeTruthy();
  });

  it("explicit 重叠时 async discovery 也只产生一个 source", async () => {
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"));
    const configPath = join(workspace, ".zcode", "config.json");
    writeJson(configPath, {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        },
      },
    });

    const { sources } = await readWorkspaceHookProjectSources({
      workingDirectory: workspace,
      explicitProjectConfigPath: configPath,
    });

    // After dedup there should be exactly one source (auto-discovered); the duplicate explicit entry is dropped
    expect(sources).toHaveLength(1);
    expect(sources[0]?.explicitProjectConfig).toBe(false);
    expect(sources[0]?.discoveryOrder).toBe(0);
  });
});
