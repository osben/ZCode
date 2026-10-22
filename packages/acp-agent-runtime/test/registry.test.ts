import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACP_AGENT_DEFINITIONS,
  acpAgentPlatformSupported,
  detectAcpAgents,
  isSafeVersionProbeArgs,
  refreshAcpAgentCache,
} from "../src/index.js";
import { buildBinaryCandidateNames } from "../src/registry.js";

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
  it("detects an installed agent with its version", async () => {
    const dir = makeBinDir();
    const binPath = writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'opencode v9.9.9'\n");
    const results = await detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 });
    const opencode = results.find((result) => result.agentId === "opencode");
    expect(opencode?.installed).toBe(true);
    expect(opencode?.commandPath).toBe(binPath);
    expect(opencode?.version).toBe("opencode v9.9.9");
    expect(results.find((result) => result.agentId === "cursor")?.installed).toBe(false);
  });

  it("reports not installed with null fields when the binary is missing", async () => {
    const dir = makeBinDir();
    const opencode = (await detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 })).find(
      (result) => result.agentId === "opencode",
    );
    expect(opencode?.installed).toBe(false);
    expect(opencode?.commandPath).toBeNull();
    expect(opencode?.version).toBeNull();
  });

  it("keeps installed=true with a null version when the probe fails", async () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "opencode", "#!/bin/sh\nexit 3\n");
    const silent = (await detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 })).find(
      (result) => result.agentId === "opencode",
    );
    expect(silent?.installed).toBe(true);
    expect(silent?.version).toBeNull();
  });

  it("reads the version from stderr when a CLI prints it there and exits non-zero", async () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'v1.2.3' 1>&2\nexit 1\n");
    const opencode = (await detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 })).find(
      (result) => result.agentId === "opencode",
    );
    expect(opencode?.installed).toBe(true);
    expect(opencode?.version).toBe("v1.2.3");
  });

  it("never probes bare `agent` for cursor (grok decollision)", async () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "agent", "#!/bin/sh\necho 'grok 0.2.101'\n");
    writeFakeBinary(dir, "cursor-agent", "#!/bin/sh\necho 'cursor-agent 2026.05.01'\n");
    const cursor = (await detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 })).find(
      (result) => result.agentId === "cursor",
    );
    expect(cursor?.installed).toBe(true);
    expect(cursor?.version).toBe("cursor-agent 2026.05.01");
    expect(cursor?.commandPath?.endsWith("cursor-agent")).toBe(true);
  });

  it("does not detect cursor when only a unrelated `agent` binary exists", async () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "agent", "#!/bin/sh\necho 'grok 0.2.101'\n");
    const cursor = (await detectAcpAgents({ env: { PATH: dir }, cacheTtlMs: 0 })).find(
      (result) => result.agentId === "cursor",
    );
    expect(cursor?.installed).toBe(false);
  });

  it("searches extraPathEntries before the environment PATH", async () => {
    const pathDir = makeBinDir();
    const extraDir = makeBinDir();
    writeFakeBinary(pathDir, "opencode", "#!/bin/sh\necho 'from-path'\n");
    const extraPath = writeFakeBinary(extraDir, "opencode", "#!/bin/sh\necho 'from-extra'\n");
    const opencode = (
      await detectAcpAgents({
        env: { PATH: pathDir },
        extraPathEntries: [extraDir],
        cacheTtlMs: 0,
      })
    ).find((result) => result.agentId === "opencode");
    expect(opencode?.commandPath).toBe(extraPath);
    expect(opencode?.version).toBe("from-extra");
  });

  it("caches results, honors the TTL, and refreshes on demand", async () => {
    let clock = 1_000;
    const dir = makeBinDir();
    const options = () => ({ env: { PATH: dir }, cacheTtlMs: 60_000, now: () => clock });

    expect(
      (await detectAcpAgents(options())).find((r) => r.agentId === "opencode")?.installed,
    ).toBe(false);

    writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'opencode v1'\n");
    expect(
      (await detectAcpAgents(options())).find((r) => r.agentId === "opencode")?.installed,
    ).toBe(false);

    clock += 60_001;
    expect(
      (await detectAcpAgents(options())).find((r) => r.agentId === "opencode")?.installed,
    ).toBe(true);

    writeFakeBinary(dir, "cursor-agent", "#!/bin/sh\necho 'cursor-agent v1'\n");
    expect((await detectAcpAgents(options())).find((r) => r.agentId === "cursor")?.installed).toBe(
      false,
    );

    refreshAcpAgentCache();
    expect((await detectAcpAgents(options())).find((r) => r.agentId === "cursor")?.installed).toBe(
      true,
    );
  });

  it("isolates the cache between different detection inputs", async () => {
    const dirA = makeBinDir();
    writeFakeBinary(dirA, "opencode", "#!/bin/sh\necho 'from-a'\n");
    const dirB = makeBinDir();

    const a = await detectAcpAgents({ env: { PATH: dirA }, cacheTtlMs: 60_000 });
    expect(a.find((result) => result.agentId === "opencode")?.installed).toBe(true);
    // The cache is keyed by the effective inputs: another environment must not
    // receive this entry within the TTL window.
    const b = await detectAcpAgents({ env: { PATH: dirB }, cacheTtlMs: 60_000 });
    expect(b.find((result) => result.agentId === "opencode")?.installed).toBe(false);
  });

  it("does not share cached versions between different probe runners", async () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'unused'\n");
    const shared = () => ({ env: { PATH: dir }, cacheTtlMs: 60_000 });

    const a = (
      await detectAcpAgents({
        ...shared(),
        runProbe: () => ({ status: 0, stdout: "opencode from-a\n", stderr: "" }),
      })
    ).find((result) => result.agentId === "opencode");
    expect(a?.version).toBe("opencode from-a");

    // The cache is keyed by the probe runner's identity: another runner with
    // the same PATH must not reuse the first runner's version within the TTL.
    const b = (
      await detectAcpAgents({
        ...shared(),
        runProbe: () => ({ status: 0, stdout: "opencode from-b\n", stderr: "" }),
      })
    ).find((result) => result.agentId === "opencode");
    expect(b?.version).toBe("opencode from-b");
  });

  it("builds Windows candidates from executable PATHEXT extensions only", () => {
    expect(buildBinaryCandidateNames("opencode", undefined, "darwin")).toEqual(["opencode"]);
    // Script shims (.bat/.cmd) and the bare extension-less name cannot be
    // launched with `shell: false`, so only real executables are probed.
    expect(buildBinaryCandidateNames("opencode", ".EXE;.CMD", "win32")).toEqual(["opencode.exe"]);
    expect(buildBinaryCandidateNames("cursor-agent", "", "win32")).toEqual([
      "cursor-agent.com",
      "cursor-agent.exe",
    ]);
    expect(buildBinaryCandidateNames("opencode", ".BAT;.CMD", "win32")).toEqual([]);
  });

  it("runs the default version probe with the scrubbed child environment", async () => {
    const dir = makeBinDir();
    writeFakeBinary(
      dir,
      "opencode",
      '#!/bin/sh\necho "opencode token=${ACP_PROBE_TOKEN:-absent} keep=${ACP_PROBE_KEEP:-absent}"\n',
    );
    const opencode = (
      await detectAcpAgents({
        env: { PATH: dir, ACP_PROBE_TOKEN: "leaked", ACP_PROBE_KEEP: "yes" },
        cacheTtlMs: 0,
      })
    ).find((result) => result.agentId === "opencode");
    expect(opencode?.version).toBe("opencode token=absent keep=yes");
  });

  it("shares one in-flight detection between concurrent callers", async () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'unused'\n");
    let probes = 0;
    const runProbe = async () => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 0, stdout: "opencode v1\n", stderr: "" };
    };
    const options = { env: { PATH: dir }, cacheTtlMs: 0, runProbe };
    const [first, second] = await Promise.all([detectAcpAgents(options), detectAcpAgents(options)]);
    expect(first).toBe(second);
    expect(probes).toBe(1);
  });

  it("never caches a run that a refresh superseded", async () => {
    const dir = makeBinDir();
    writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'unused'\n");
    let calls = 0;
    const runProbe = async () => {
      calls += 1;
      const current = calls === 1 ? "stale" : "fresh";
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 0, stdout: `opencode ${current}\n`, stderr: "" };
    };
    const options = { env: { PATH: dir }, cacheTtlMs: 60_000, runProbe };
    const stale = detectAcpAgents(options);
    refreshAcpAgentCache();
    expect((await stale).find((r) => r.agentId === "opencode")?.version).toBe("opencode stale");
    expect((await detectAcpAgents(options)).find((r) => r.agentId === "opencode")?.version).toBe(
      "opencode fresh",
    );
  });

  it("uses the injected probe runner with the whitelisted arguments", async () => {
    const dir = makeBinDir();
    const binPath = writeFakeBinary(dir, "opencode", "#!/bin/sh\necho 'unused'\n");
    const calls: { commandPath: string; args: readonly string[] }[] = [];
    const opencode = (
      await detectAcpAgents({
        env: { PATH: dir },
        cacheTtlMs: 0,
        runProbe: (commandPath, args) => {
          calls.push({ commandPath, args });
          return { status: 0, stdout: "opencode vX\n", stderr: "" };
        },
      })
    ).find((result) => result.agentId === "opencode");
    expect(opencode?.version).toBe("opencode vX");
    expect(calls).toEqual([{ commandPath: binPath, args: ["--version"] }]);
  });
});

describe("agent definitions", () => {
  it("declares the fixed agent set with each adapter's own spawn arguments", () => {
    // Pinned per agent (specs/acp-agent-runtime.md "Agents"). Codex and Claude run through npm
    // adapters that serve ACP with no arguments; Gemini (`--experimental-acp`) is not live-verified.
    const spawnArgsByAgent: Record<string, readonly string[]> = {
      opencode: ["acp"],
      cursor: ["acp"],
      qwen: ["--acp"],
      codex: [],
      claude: [],
      gemini: ["--experimental-acp"],
    };
    expect(ACP_AGENT_DEFINITIONS.map((definition) => definition.agentId)).toEqual(
      Object.keys(spawnArgsByAgent),
    );
    for (const definition of ACP_AGENT_DEFINITIONS) {
      expect(isSafeVersionProbeArgs(definition.versionArgs)).toBe(true);
      expect(definition.versionArgs).toEqual(["--version"]);
      expect(definition.spawnArgs).toEqual(spawnArgsByAgent[definition.agentId]);
      expect(definition.binaries.length).toBeGreaterThan(0);
      expect(definition.displayName.length).toBeGreaterThan(0);
    }
    expect(isSafeVersionProbeArgs(["--version"])).toBe(true);
    expect(isSafeVersionProbeArgs(["-v"])).toBe(true);
    expect(isSafeVersionProbeArgs(["acp"])).toBe(false);
    expect(isSafeVersionProbeArgs(["-e", "code"])).toBe(false);
    expect(isSafeVersionProbeArgs([])).toBe(false);
  });

  it("declares fixed login and status arguments only where the agent binary has them", () => {
    // Qwen, Codex, Claude and Gemini have no login or status subcommand on the adapter binary
    // (qwen `auth` is removed; the adapters use the vendor login). No helper is invented for them.
    const withoutHelpers = ["qwen", "codex", "claude", "gemini"];
    for (const definition of ACP_AGENT_DEFINITIONS) {
      if (withoutHelpers.includes(definition.agentId)) {
        expect(definition.loginArgs).toEqual([]);
        expect(definition.statusArgs).toBeUndefined();
        continue;
      }
      expect(definition.loginArgs.length).toBeGreaterThan(0);
      expect(definition.loginArgs.every((arg) => typeof arg === "string" && arg.length > 0)).toBe(
        true,
      );
      if (definition.statusArgs !== undefined) {
        expect(definition.statusArgs.length).toBeGreaterThan(0);
        expect(
          definition.statusArgs.every((arg) => typeof arg === "string" && arg.length > 0),
        ).toBe(true);
      }
    }
    expect(ACP_AGENT_DEFINITIONS.find((item) => item.agentId === "cursor")?.statusArgs).toEqual([
      "status",
    ]);
  });
});

describe("ACP agent platform scope", () => {
  it("supports macOS only until Windows and Linux are verified", () => {
    expect(acpAgentPlatformSupported("darwin")).toBe(true);
    expect(acpAgentPlatformSupported("linux")).toBe(false);
    expect(acpAgentPlatformSupported("win32")).toBe(false);
  });
});
