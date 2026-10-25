import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

const execute = promisify(execFile);
const baselineHash = "beed22c68890d35d502516e8854be9cfe486a109b199be79868aae2e002058eb";
const generator = fileURLToPath(
  new URL("../../../scripts/generate-bash-command-registry.mjs", import.meta.url),
);

describe("generated Bash command registry", () => {
  it("materializes only the accessed root and caches its identity", async () => {
    vi.resetModules();
    const { BASH_COMMAND_REGISTRY: registry } =
      await import("../src/tool/handlers/generated/bash-command-registry.js");
    expect(Object.keys(registry)).toHaveLength(707);
    expect(Object.hasOwn(registry, "git")).toBe(true);
    expect(Object.hasOwn(registry, "customer-private-script")).toBe(false);
    const { classifySafeCommandIdentity } = await import("../src/tool/handlers/tool-perf.js");
    expect(classifySafeCommandIdentity("git status --short")).toEqual({ count: 1, name: "git" });
    expect(Object.getOwnPropertyDescriptor(registry, "git")?.get).toBeTypeOf("function");
    expect(Object.getOwnPropertyDescriptor(registry, "mongocli")?.get).toBeTypeOf("function");
    const git = registry.git;
    expect(git?.[0]).toEqual(["git"]);
    expect(registry.git).toBe(git);
    expect(Object.getOwnPropertyDescriptor(registry, "git")?.value).toBe(git);
    expect(Object.getOwnPropertyDescriptor(registry, "mongocli")?.get).toBeTypeOf("function");
    expect(registry["customer-private-script"]).toBeUndefined();
  });

  it("preserves every eager-baseline root, alias, option, argument flag and child", async () => {
    const { BASH_COMMAND_REGISTRY: registry } =
      await import("../src/tool/handlers/generated/bash-command-registry.js");
    expect(createHash("sha256").update(JSON.stringify(registry)).digest("hex")).toBe(baselineHash);
  });

  it("generates deterministic, standalone lazy output and passes the freshness gate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-registry-test-"));
    try {
      const first = join(directory, "first.ts");
      const second = join(directory, "second.ts");
      await execute(process.execPath, [generator, "--output", first]);
      await execute(process.execPath, [generator, "--output", second]);
      expect(await readFile(first, "utf8")).toBe(await readFile(second, "utf8"));
      await execute(process.execPath, [generator, "--check"]);
      const { stdout } = await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `
        import { createHash } from 'node:crypto';
        import { pathToFileURL } from 'node:url';
        const { BASH_COMMAND_REGISTRY: registry } = await import(pathToFileURL(process.argv[1]));
        const lazy = typeof Object.getOwnPropertyDescriptor(registry, 'git').get === 'function';
        console.log(JSON.stringify({lazy, roots: Object.keys(registry).length,
          hash: createHash('sha256').update(JSON.stringify(registry)).digest('hex')}));
      `,
        first,
      ]);
      expect(JSON.parse(stdout)).toEqual({ lazy: true, roots: 707, hash: baselineHash });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
