import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACP_AGENT_DEFINITIONS,
  detectAcpAgents,
  isSafeVersionProbeArgs,
  refreshAcpAgentCache,
} from "../src/index.js";

const tempDirs: string[] = [];

function makeBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-registry-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeFakeBinary(dir: string, name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  refreshAcpAgentCache();
});

describe("detectAcpAgents", () => {
  it("detects an installed agent with its version", () => {
    const dir = makeBinDir();
    const binPath = writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'opencode v9.9.9'\n");
    const results = detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 });
    const opencode = results.find((result) => result.agentId === "opencode");
    expect(opencode?.installed).toBe(true);
    expect(opencode?.commandPath).toBe(binPath);
    expect(opencode?.version).toBe("opencode v9.9.9");
    expect(results.find((result) => result.agentId === "cursor")?.installed).toBe(false);
  });

  it("reports not installed with null fields when the binary is missing", () => {
    const dir = makeBinDir();
    const opencode = detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 }).find(
      (result) => result.agentId === "opencode",
    );
    expect(opencode?.installed).toBe(false);
    expect(opencode?.commandPath).toBeNull();
    expect(opencode?.version).toBeNull();
  });

  it("keeps installed=true with a null version when the probe fails", () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "opencode", "#!/bin/sh\nexit 3\n");
    const silent = detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 }).find(
      (result) => result.agentId === "opencode",
    );
    expect(silent?.installed).toBe(true);
    expect(silent?.version).toBeNull();
  });

  it("reads the version from stderr when a CLI prints it there and exits non-zero", () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'v1.2.3' 1>&2\nexit 1\n");
    const opencode = detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 }).find(
      (result) => result.agentId === "opencode",
    );
    expect(opencode?.installed).toBe(true);
    expect(opencode?.version).toBe("v1.2.3");
  });

  it("never probes bare `agent` for cursor (grok decollision)", () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "agent", "#!/bin/sh\necho 'grok 0.2.101'\n");
    writeFakeBinary(dir, "cursor-agent", "#!/bin/sh\necho 'cursor-agent 2026.05.01'\n");
    const cursor = detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 }).find(
      (result) => result.agentId === "cursor",
    );
    expect(cursor?.installed).toBe(true);
    expect(cursor?.version).toBe("cursor-agent 2026.05.01");
    expect(cursor?.commandPath?.endsWith("cursor-agent")).toBe(true);
  });

  it("does not detect cursor when only a unrelated `agent` binary exists", () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "agent", "#!/bin/sh\necho 'grok 0.2.101'\n");
    const cursor = detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 }).find(
      (result) => result.agentId === "cursor",
    );
    expect(cursor?.installed).toBe(false);
  });

  it("searches extraPathEntries before the environment PATH", () => {
    const pathDir = makeBinDir();
    const extraDir = makeBinDir();
    writeFakeBinary(pathDir, "opencode", "#!/bin/sh\necho 'from-path'\n");
    const extraPath = writeFakeBinary(extraDir, "opencode", "#!/bin/sh\necho 'from-extra'\n");
    const opencode = detectAcpAgents({
      env: { PATH: pathDir },
      extraPathEntries: [extraDir],
      cacheTtlMs: 0,
    }).find((result) => result.agentId === "opencode");
    expect(opencode?.commandPath).toBe(extraPath);
    expect(opencode?.version).toBe("from-extra");
  });

  it("caches results, honors the TTL, and refreshes on demand", () => {
    let clock = 1_000;
    const dir = makeBinDir();
    const options = () => ({ env: { PATH: dir }, cacheTtlMs: 60_000, now: () => clock });

    expect(detectAcpAgents(options()).find((r) => r.agentId === "opencode")?.installed).toBe(false);

    writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'opencode v1'\n");
    expect(detectAcpAgents(options()).find((r) => r.agentId === "opencode")?.installed).toBe(false);

    clock += 60_001;
    expect(detectAcpAgents(options()).find((r) => r.agentId === "opencode")?.installed).toBe(true);

    writeFakeBinary(dir, "cursor-agent", "#!/bin/sh\necho 'cursor-agent v1'\n");
    expect(detectAcpAgents(options()).find((r) => r.agentId === "cursor")?.installed).toBe(false);

    refreshAcpAgentCache();
    expect(detectAcpAgents(options()).find((r) => r.agentId === "cursor")?.installed).toBe(true);
  });

  it("uses the injected probe runner with the whitelisted arguments", () => {
    const dir = makeBinDir();
    const binPath = writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'unused'\n");
    const calls: { commandPath: string; args: readonly string[] }[] = [];
    const opencode = detectAcpAgents({
      env: { PATH: dir },
      cacheTtlMs: 0,
      runProbe: (commandPath, args) => {
        calls.push({ commandPath, args });
        return { status: 0, stdout: "opencode vX\n", stderr: "" };
      },
    }).find((result) => result.agentId === "opencode");
    expect(opencode?.version).toBe("opencode vX");
    expect(calls).toEqual([{ commandPath: binPath, args: ["--version"] }]);
  });
});

describe("agent definitions", () => {
  it("declares only whitelisted version-probe arguments and acp spawn arguments", () => {
    for (const definition of ACP_AGENT_DEFINITIONS) {
      expect(isSafeVersionProbeArgs(definition.versionArgs)).toBe(true);
      expect(definition.spawnArgs).toEqual(["acp"]);
      expect(definition.binaries.length).toBeGreaterThan(0);
      expect(definition.displayName.length).toBeGreaterThan(0);
    }
    expect(isSafeVersionProbeArgs(["--version"])).toBe(true);
    expect(isSafeVersionProbeArgs(["-v"])).toBe(true);
    expect(isSafeVersionProbeArgs(["acp"])).toBe(false);
    expect(isSafeVersionProbeArgs(["-e", "code"])).toBe(false);
    expect(isSafeVersionProbeArgs([])).toBe(false);
  });
});
