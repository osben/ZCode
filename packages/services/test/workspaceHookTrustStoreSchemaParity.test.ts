import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHooksService } from "../src/hooks/hooksService.js";
import {
  parseWorkspaceHookTrustStoreContent,
  type WorkspaceHookTrustStoreParseResult,
} from "@zcode/shared/workspace-hook-trust-store-file";

/**
 * Trust store schema parity (CR-01 regression).
 *
 * Bug background: the services layer used to read the trust store with hand-written partial field validation, while
 * runtime/adapters use the complete strict schema from contracts. Given the same "valid JSON but invalid structure"
 * file, services would display a plausible-looking digest as trusted_persistent while runtime fail-closed blocked
 * everything — splitting UI and execution-layer state. The trust store is a permission boundary; all consumers must
 * reach the same conclusion about the same file.
 *
 * This test uses shared's parseWorkspaceHookTrustStoreContent (a re-export from the same source as the contracts
 * schema used by adapters) as the runtime-side verdict baseline, and asserts over a set of corrupted samples:
 * runtime invalid ⇔ services must be corrupt and produce no trusted display; runtime ok ⇔ services adopt the matching digest.
 */

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hook-trust-parity-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function setupWorkspaceWithHook(): { home: string; workspace: string } {
  const home = makeRoot();
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
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  return { home, workspace };
}

function trustStorePath(home: string): string {
  return join(home, ".zcode", "security", "workspace-hook-trust-v1.json");
}

const VALID_DIGEST = "a".repeat(64);

function runtimeVerdict(content: string): WorkspaceHookTrustStoreParseResult {
  return parseWorkspaceHookTrustStoreContent(content);
}

/** CR-01 original symptom samples: valid JSON, digest looks valid, but the structure does not match the schema. */
const STRUCTURALLY_INVALID_SAMPLES: Array<{ name: string; file: unknown }> = [
  {
    name: "缺少 schemaVersion",
    file: { records: [{ workspaceIdentity: "PLACEHOLDER", hookDeclarationDigest: VALID_DIGEST }] },
  },
  {
    name: "record 缺少 decision/grantedAt/digestAlgorithm 等必需字段",
    file: {
      schemaVersion: 1,
      records: [{ workspaceIdentity: "PLACEHOLDER", hookDeclarationDigest: VALID_DIGEST }],
    },
  },
  {
    name: "非法 decision",
    file: {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: "PLACEHOLDER",
          hookDeclarationDigest: VALID_DIGEST,
          digestAlgorithm: "sha256",
          decision: "allow_once",
          grantedAt: "2026-08-17T09:00:00.000Z",
          eventAtGrant: "SessionStart",
          displayCommandAtGrant: "node recorder.mjs",
          sourcePathAtGrant: ".zcode/config.json",
        },
      ],
    },
  },
  {
    name: "非法时间戳",
    file: {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: "PLACEHOLDER",
          hookDeclarationDigest: VALID_DIGEST,
          digestAlgorithm: "sha256",
          decision: "trusted",
          grantedAt: "not-a-timestamp",
          eventAtGrant: "SessionStart",
          displayCommandAtGrant: "node recorder.mjs",
          sourcePathAtGrant: ".zcode/config.json",
        },
      ],
    },
  },
  {
    name: "records 非数组",
    file: { schemaVersion: 1, records: { workspaceIdentity: "PLACEHOLDER" } },
  },
  {
    name: "未知顶层字段",
    file: {
      schemaVersion: 1,
      records: [],
      extra: { workspaceIdentity: "PLACEHOLDER", hookDeclarationDigest: VALID_DIGEST },
    },
  },
  {
    name: "未知 record 字段",
    file: {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: "PLACEHOLDER",
          hookDeclarationDigest: VALID_DIGEST,
          digestAlgorithm: "sha256",
          decision: "trusted",
          grantedAt: "2026-08-17T09:00:00.000Z",
          eventAtGrant: "SessionStart",
          displayCommandAtGrant: "node recorder.mjs",
          sourcePathAtGrant: ".zcode/config.json",
          injected: true,
        },
      ],
    },
  },
];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("trust store schema parity：services 与 runtime 对同一文件必须同判（CR-01）", () => {
  for (const sample of STRUCTURALLY_INVALID_SAMPLES) {
    it(`结构非法样本（${sample.name}）：runtime 判 invalid ⇔ services 必须 corrupt 且不展示 trusted`, async () => {
      const { home, workspace } = setupWorkspaceWithHook();

      // First obtain the real digest declared for this workspace and substitute it for the sample
      // placeholder, ensuring "the digest should have matched".
      const first = await createHooksService().loadHooks({ workspacePath: workspace });
      const digest = first.workspaceHookSnapshot?.hooks[0]?.hookDeclarationDigest;
      expect(digest).toBeTruthy();
      // Bugfix reason: replacing the workspace path directly into the JSON string via replaceAll
      // injects unescaped backslashes on Windows, producing invalid JSON (Bad escaped character)
      // and crashing sample construction. Replacing the quotes too with JSON.stringify's output
      // keeps the path escaping valid on any platform.
      const serialized = JSON.stringify(sample.file).replaceAll(
        '"PLACEHOLDER"',
        JSON.stringify(workspace),
      );

      // Baseline: the runtime side (shared schema, same source as adapters) judges it invalid.
      expect(runtimeVerdict(serialized).status).toBe("invalid");

      writeJson(trustStorePath(home), JSON.parse(serialized));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const loaded = await createHooksService().loadHooks({ workspacePath: workspace });

      // services must fail closed: no trusted display, marked corrupt, diagnostic emitted.
      expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("pending_trust");
      expect(loaded.trustStoreCorrupt).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    });
  }

  it("合法完整记录：runtime 判 ok ⇔ services 采纳匹配 digest 展示 trusted_persistent", async () => {
    const { home, workspace } = setupWorkspaceWithHook();
    const first = await createHooksService().loadHooks({ workspacePath: workspace });
    const digest = first.workspaceHookSnapshot?.hooks[0]?.hookDeclarationDigest;
    expect(digest).toBeTruthy();

    const file = {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: workspace,
          hookDeclarationDigest: digest,
          digestAlgorithm: "sha256",
          decision: "trusted",
          grantedAt: "2026-08-17T09:00:00.000Z",
          eventAtGrant: "SessionStart",
          displayCommandAtGrant: "echo hello",
          sourcePathAtGrant: ".zcode/config.json",
        },
      ],
    };
    const serialized = JSON.stringify(file);
    expect(runtimeVerdict(serialized).status).toBe("ok");

    writeJson(trustStorePath(home), file);
    const loaded = await createHooksService().loadHooks({ workspacePath: workspace });
    expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("trusted_persistent");
    expect(loaded.trustStoreCorrupt).toBeUndefined();
  });

  it("合法文件但记录属于其他 workspace：services 只采纳本 workspace 的 digest", async () => {
    const { home, workspace } = setupWorkspaceWithHook();
    const first = await createHooksService().loadHooks({ workspacePath: workspace });
    const digest = first.workspaceHookSnapshot?.hooks[0]?.hookDeclarationDigest;

    const file = {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: "/another/workspace",
          hookDeclarationDigest: digest,
          digestAlgorithm: "sha256",
          decision: "trusted",
          grantedAt: "2026-08-17T09:00:00.000Z",
          eventAtGrant: "SessionStart",
          displayCommandAtGrant: "echo hello",
          sourcePathAtGrant: ".zcode/config.json",
        },
      ],
    };
    const serialized = JSON.stringify(file);
    expect(runtimeVerdict(serialized).status).toBe("ok");

    writeJson(trustStorePath(home), file);
    const loaded = await createHooksService().loadHooks({ workspacePath: workspace });
    expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("pending_trust");
    expect(loaded.trustStoreCorrupt).toBeUndefined();
  });
});
