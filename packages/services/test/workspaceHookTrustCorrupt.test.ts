import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHooksService } from "../src/hooks/hooksService.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hook-trust-corrupt-"));
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

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readPersistentWorkspaceHookTrustDigests corrupt 检测（#7）", () => {
  it("trust store 文件不存在时返回空集且不发警告、不标记 corrupt", async () => {
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

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await createHooksService().loadHooks({
      workspacePath: workspace,
    });

    // File missing ⇒ reasonably no record; the hook is marked pending_trust (not persistently trusted), not corrupt.
    expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("pending_trust");
    expect(loaded.trustStoreCorrupt).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("trust store JSON 畸形时发警告、标记 corrupt、fail-closed 不返回 digest", async () => {
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

    // Load once first to get the declaration digest, then write a malformed trust store.
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    const first = await createHooksService().loadHooks({
      workspacePath: workspace,
    });
    const digest = first.workspaceHookSnapshot?.hooks[0]?.hookDeclarationDigest;
    expect(digest).toBeTruthy();

    // Write a valid complete trust record to prove: if the trust store is malformed, valid records are
    // not adopted. After CR-01, services use the same complete strict schema as the runtime — the record
    // must contain all required fields (the old test only wrote identity+digest, which happened to rely
    // on the partially-validating bug that has since been fixed).
    writeJson(join(home, ".zcode", "security", "workspace-hook-trust-v1.json"), {
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
    });

    // Verify it would be trusted under normal conditions.
    const trusted = await createHooksService().loadHooks({
      workspacePath: workspace,
    });
    expect(trusted.hooks[0]?.workspaceHook?.trustState).toBe("trusted_persistent");

    // Overwrite with malformed JSON.
    writeJson(
      join(home, ".zcode", "security", "workspace-hook-trust-v1.json"),
      "{ this is :: not valid JSON !!!",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await createHooksService().loadHooks({
      workspacePath: workspace,
    });

    // Fail-closed: even though the record would have matched, the corrupted file returns no digest and
    // the hook falls back to pending_trust.
    expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("pending_trust");
    expect(loaded.trustStoreCorrupt).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    // The unified ServiceLogger splits scope, message, and structured path into three arguments.
    // After CR-01, illegal JSON uniformly goes through the schema-parsing branch with the message
    // "结构不符合 schema" (aligned with how runtime/adapters judge the same kind of file corrupt).
    expect(warnSpy.mock.calls[0]).toEqual([
      expect.stringContaining("[hooks-service]"),
      expect.stringContaining("Workspace Hook Trust store 结构不符合 schema"),
      expect.objectContaining({ path: expect.stringContaining("workspace-hook-trust") }),
    ]);
  });

  it("trust store 根节点非对象时同样标记 corrupt 并 fail-closed", async () => {
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

    // Root node is an array (not an object).
    writeJson(join(home, ".zcode", "security", "workspace-hook-trust-v1.json"), []);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await createHooksService().loadHooks({
      workspacePath: workspace,
    });

    expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("pending_trust");
    expect(loaded.trustStoreCorrupt).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});
