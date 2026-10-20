import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalDataDir = process.env.ZCODE_DATA_BASE_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataDir === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
  else process.env.ZCODE_DATA_BASE_DIR = originalDataDir;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("standalone Source Server host assembly (node exports)", () => {
  it("exposes the server-cli exports from @zcode/services/node", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-server-host-home-"));
    tempDirs.push(home);
    process.env.HOME = home;
    process.env.ZCODE_DATA_BASE_DIR = join(home, "data");
    vi.resetModules();
    const node = await import("../src/node.js");

    expect(typeof node.createServerHostServices).toBe("function");
    expect(typeof node.migrateApplicationStorage).toBe("function");
    expect(typeof node.SourceServerWorkspaceAliasRepo).toBe("function");
    expect(typeof node.SourceServerWorkspaceIdentityChannelServer).toBe("function");
    expect(typeof node.SourceServerWorkspaceIdentityMapper).toBe("function");
    expect(typeof node.scopeConversationShareServiceForAttachment).toBe("function");
  });

  it("rejects an empty Source Server id before opening any storage", async () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-server-host-invalid-"));
    tempDirs.push(home);
    process.env.HOME = home;
    process.env.ZCODE_DATA_BASE_DIR = join(home, "data");
    vi.resetModules();
    const node = await import("../src/node.js");

    await expect(
      node.createServerHostServices({
        sourceServerId: "",
        zcodeBuiltinProviderConfigFilePath: join(home, "builtin.json"),
      }),
    ).rejects.toThrow(/serverId/);
  });
});
