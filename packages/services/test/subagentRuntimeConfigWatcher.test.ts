import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  rename,
  readFile,
  chmod,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

// Only observe real backfill-scan stat counts; actually entering the stable wait serves as the timing evidence.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.mocked(stat).mockClear();
});
const until = (assertion: () => unknown) => vi.waitFor(assertion, { timeout: 8000, interval: 20 });
async function pair(prepareHome?: (homeDir: string) => Promise<void>) {
  const homeDir = await mkdtemp(join(tmpdir(), "subagent-host-watch-"));
  cleanup.push(() => rm(homeDir, { recursive: true, force: true }));
  await prepareHome?.(homeDir);
  const a = createSubagentsService({ homeDir }),
    b = createSubagentsService({ homeDir });
  cleanup.push(
    () => a.disposeAll(),
    () => b.disposeAll(),
  );
  const workspace = { workspacePath: join(homeDir, "workspace") };
  await a.prepareRuntimeState(workspace);
  await b.prepareRuntimeState(workspace);
  // Bug root cause: on macOS fs.watch goes through FSEvents, and even after watch() returns and Chokidar is ready the
  // native stream still needs a short time to become effective; changes in that window are silently lost (measured:
  // about 1/8 of immediate writes lost, 0 lost after 200ms). Running the whole file back-to-back is under higher load,
  // so cases randomly miss events; cross the startup dead window before mutating files.
  await delay(500);
  const both = async (expected: unknown) =>
    until(async () => {
      expect(await a.readRuntimeConfig(workspace)).toMatchObject(expected);
      expect(await b.readRuntimeConfig(workspace)).toEqual(await a.readRuntimeConfig(workspace));
    });
  return { a, b, workspace, homeDir, both };
}
const config = (name = "researcher", systemPrompt = "old") => ({
  name,
  description: "Research",
  systemPrompt,
});
const markdown = (name: string, prompt = "old") =>
  `---\nname: ${name}\ndescription: Research\n---\n${prompt}`;

async function sameDirectory(left: string, right: string) {
  const a = await stat(left);
  const b = await stat(right).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return Boolean(b && a.dev === b.dev && a.ino === b.ino);
}

describe("native subagent Host watchers", () => {
  it("keeps shared recovery in the background while new workspace preparations and queued saves finish", async () => {
    const f = await pair();
    const root = join(f.homeDir, ".zcode", "agents");
    await rm(root, { recursive: true, force: true });
    await f.both({ kind: "ready", profiles: [] });
    const path = join(root, "researcher.md");
    await mkdir(root, { recursive: true });
    let active = true,
      writes = 0;
    await writeFile(path, markdown("researcher", `write-${writes}`));
    const writer = (async () => {
      while (active) {
        await delay(100);
        if (active) await writeFile(path, markdown("researcher", `write-${++writes}`));
      }
    })();
    const stop = async () => {
      active = false;
      await writer;
    };
    cleanup.push(stop);
    await until(() =>
      expect(vi.mocked(stat).mock.calls.filter(([p]) => p === path).length).toBeGreaterThanOrEqual(
        4,
      ),
    );
    const before = await f.a.readRuntimeConfig(f.workspace);
    expect(before).toMatchObject({ kind: "ready", profiles: [] });
    const others = ["b", "c"].map((name) => ({ workspacePath: join(f.homeDir, name) }));
    let completed = false;
    const preparing = Promise.all([
      ...others.map((workspace) => f.a.prepareRuntimeState(workspace)),
      f.a.setEnabled({ agentId: "user:user:unrelated", enabled: false }),
    ]).then(() => {
      completed = true;
    });
    try {
      // Writes continue while waiting; we must not stop writing first and then prove preparation and the write queue are released.
      await vi.waitFor(() => expect(completed).toBe(true), { timeout: 4000 });
      for (const workspace of others)
        expect(await f.a.readRuntimeConfig(workspace)).toEqual(before);
      await until(() => expect(writes).toBeGreaterThanOrEqual(60));
      await f.both(before);
    } finally {
      await stop();
      await preparing;
    }
    const expected = { kind: "ready", profiles: [{ systemPrompt: `write-${writes}` }] };
    await f.both(expected);
    for (const workspace of others)
      expect(await f.a.readRuntimeConfig(workspace)).toMatchObject(expected);
    expect(before).toMatchObject({ profiles: [] });
  }, 20000);

  for (const scope of ["user", "project"] as const) {
    for (const operation of ["update", "delete", "rename"] as const) {
      it(`${scope} ${operation} reaches both Hosts when the real directory is AGENTS`, async ({
        skip,
      }) => {
        const f = await pair(async (home) => {
          const parent =
            scope === "user" ? join(home, ".zcode") : join(home, "workspace", ".zcode");
          const actual = join(parent, "AGENTS");
          await mkdir(actual, { recursive: true });
          if (!(await sameDirectory(actual, join(parent, "agents"))))
            skip("Requires a case-insensitive test filesystem");
          await writeFile(join(actual, "researcher.md"), markdown("researcher"));
        });
        await f.both({ kind: "ready", profiles: [{ name: "researcher", systemPrompt: "old" }] });
        const parent =
          scope === "user" ? join(f.homeDir, ".zcode") : join(f.workspace.workspacePath, ".zcode");
        const logical = join(parent, "agents", "researcher.md");
        const actual = join(parent, "AGENTS", "researcher.md");
        if (operation === "delete") await rm(logical);
        else {
          const agentId =
            scope === "user"
              ? "user:user:researcher"
              : `workspace:${f.workspace.workspacePath}:researcher`;
          await f.a.updateAgent({
            agentId,
            oldFilePath: logical,
            ...(scope === "project"
              ? ({ scope: "workspace", workspacePath: f.workspace.workspacePath } as const)
              : {}),
            config: config(operation === "rename" ? "renamed" : "researcher", "new"),
          });
          expect(
            await readFile(
              operation === "rename" ? join(parent, "AGENTS", "renamed.md") : actual,
              "utf8",
            ),
          ).toContain("new");
        }
        if (operation !== "update")
          await expect(stat(actual)).rejects.toMatchObject({ code: "ENOENT" });
        // After the file has been persisted, both independent caches must converge; restart or manual reload must not be needed to fix the result.
        await f.both({
          profiles:
            operation === "delete"
              ? []
              : [{ name: operation === "rename" ? "renamed" : "researcher", systemPrompt: "new" }],
        });
      }, 15000);
    }
  }

  for (const mode of ["first creation", "recreation"]) {
    it(`observes project directory ${mode} with different casing`, async ({ skip }) => {
      const f = await pair(async (home) => {
        const probe = join(home, "CaseProbe");
        await mkdir(probe);
        if (!(await sameDirectory(probe, join(home, "caseprobe"))))
          skip("Requires a case-insensitive test filesystem");
        await rm(probe, { recursive: true });
      });
      const parent = join(f.workspace.workspacePath, ".zcode");
      const logical = join(parent, "agents");
      if (mode === "recreation") {
        await mkdir(logical, { recursive: true });
        await writeFile(join(logical, "researcher.md"), markdown("researcher"));
        await f.both({ profiles: [{ name: "researcher", systemPrompt: "old" }] });
        await rm(logical, { recursive: true });
        await f.both({ profiles: [] });
      }
      await mkdir(join(parent, "AGENTS"), { recursive: true });
      await writeFile(join(logical, "researcher.md"), markdown("researcher", "new"));
      await f.both({ profiles: [{ name: "researcher", systemPrompt: "new" }] });
    }, 20000);
  }

  it("does not merge distinct agents and AGENTS directories on a case-sensitive filesystem", async ({
    skip,
  }) => {
    const f = await pair(async (home) => {
      const root = join(home, ".zcode", "agents");
      await mkdir(root, { recursive: true });
      if (await sameDirectory(root, join(home, ".zcode", "AGENTS")))
        skip("Requires a case-sensitive test filesystem");
      await mkdir(join(home, ".zcode", "AGENTS"));
      await writeFile(join(root, "researcher.md"), markdown("researcher"));
      await writeFile(join(home, ".zcode", "AGENTS", "unrelated.md"), markdown("unrelated"));
    });
    await f.both({ profiles: [{ name: "researcher", systemPrompt: "old" }] });
    await writeFile(
      join(f.homeDir, ".zcode", "AGENTS", "unrelated.md"),
      markdown("unrelated", "wrong"),
    );
    await writeFile(
      join(f.homeDir, ".zcode", "agents", "researcher.md"),
      markdown("researcher", "new"),
    );
    await f.both({ profiles: [{ name: "researcher", systemPrompt: "new" }] });
  });

  it("removes the old cache entry after a filename-only case rename", async () => {
    const f = await pair(async (home) => {
      await mkdir(join(home, ".zcode", "agents"), { recursive: true });
      await writeFile(join(home, ".zcode", "agents", "Researcher.MD"), markdown("researcher"));
    });
    await f.both({ profiles: [{ name: "researcher", systemPrompt: "old" }] });
    const root = join(f.homeDir, ".zcode", "agents");
    await rename(join(root, "Researcher.MD"), join(root, "researcher.md"));
    await writeFile(join(root, "researcher.md"), markdown("researcher", "new"));
    await f.both({ profiles: [{ name: "researcher", systemPrompt: "new" }] });
    await rm(join(root, "researcher.md"));
    await f.both({ profiles: [] });
  });

  it("both Hosts observe profile and state changes through a linked configuration root", async () => {
    const f = await pair(async (homeDir) => {
      const storage = join(homeDir, "linked-storage");
      await mkdir(join(storage, "agents"), { recursive: true });
      await mkdir(join(storage, "v2"));
      // Windows uses a directory junction (no admin rights needed); other platforms use a directory symlink.
      await symlink(
        storage,
        join(homeDir, ".zcode"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await writeFile(
        join(storage, "agents", "researcher.md"),
        "---\nname: researcher\ndescription: Research\n---\nold",
      );
    });
    await f.both({ kind: "ready", profiles: [{ name: "researcher", systemPrompt: "old" }] });
    const agentId = "user:user:researcher";
    await f.a.updateAgent({
      agentId,
      oldFilePath: join(f.homeDir, ".zcode", "agents", "researcher.md"),
      config: config("researcher", "new"),
    });
    expect(
      await readFile(join(f.homeDir, "linked-storage", "agents", "researcher.md"), "utf8"),
    ).toContain("new");
    await f.both({ profiles: [{ name: "researcher", systemPrompt: "new" }] });
    await f.a.setEnabled({ agentId, enabled: false });
    await f.both({ profiles: [] });
  }, 15000);

  it.each([
    "create",
    "update",
    "rename",
    "delete",
    "disable",
    "enable",
    "builtin",
    "plugin",
  ] as const)(
    "both independent Hosts consume %s without broadcasts",
    async (operation) => {
      const f = await pair();
      const { agent } = await f.a.createAgent({ config: config() });
      await f.both({ kind: "ready", profiles: [{ name: "researcher" }] });
      if (operation === "enable" || operation === "rename") {
        await f.a.setEnabled({ agentId: agent.id, enabled: false });
        await f.both({ profiles: [] });
      }
      const before = await f.b.readRuntimeConfig(f.workspace);
      if (operation === "create") await f.a.createAgent({ config: config("second") });
      if (operation === "update" || operation === "rename")
        await f.a.updateAgent({
          agentId: agent.id,
          oldFilePath: agent.path,
          config: config(operation === "rename" ? "renamed" : "researcher", "new"),
        });
      if (operation === "delete")
        await f.a.deleteAgent({ agentId: agent.id, filePath: agent.path });
      if (operation === "disable" || operation === "enable")
        await f.a.setEnabled({ agentId: agent.id, enabled: operation === "enable" });
      if (operation === "builtin")
        await f.a.setBuiltInModelOverride({
          agentName: "Explore",
          modelSelection: { providerId: "test", modelId: "new" },
        });
      if (operation === "plugin")
        await f.a.setPluginAgentModelOverride({
          agentId: "plugin:test:researcher",
          modelSelection: { providerId: "test", modelId: "new" },
        });
      await until(async () => {
        const next = await f.a.readRuntimeConfig(f.workspace);
        expect(next).toEqual(await f.b.readRuntimeConfig(f.workspace));
        if (operation !== "rename") expect(next).not.toEqual(before);
        if (operation === "rename") {
          expect(next).toMatchObject({ profiles: [] });
          expect(
            JSON.parse(await readFile(join(f.homeDir, ".zcode", "v2", "agents-state.json"), "utf8"))
              .disabledAgentIds,
          ).toContain("user:user:renamed");
        }
      });
      if (operation === "rename") {
        await f.a.setEnabled({ agentId: "user:user:renamed", enabled: true });
        await f.both({ profiles: [{ name: "renamed", systemPrompt: "new" }] });
      }
    },
    15000,
  );

  it.each(["user", "project"] as const)(
    "keeps %s scans and native updates limited to direct files",
    async (scope) => {
      const rootFor = (home: string) =>
        join(home, ...(scope === "project" ? ["workspace"] : []), ".zcode", "agents");
      const md = (prompt: string) => `---\nname: external\ndescription: External\n---\n${prompt}`;
      const f = await pair(async (home) => {
        const root = rootFor(home);
        await mkdir(join(root, "nested"), { recursive: true });
        await writeFile(join(root, "nested", "deep.md"), markdown("nested-agent", "initial"));
        await writeFile(join(root, "external.markdown"), md("first"));
      });
      const root = rootFor(f.homeDir);
      const path = join(root, "external.markdown");
      await f.both({ profiles: [{ name: "external", systemPrompt: "first" }] });
      await writeFile(join(root, "temp"), md("atomic"));
      await rename(join(root, "temp"), path);
      await f.both({ profiles: [{ systemPrompt: "atomic" }] });
      await rm(root, { recursive: true });
      await f.both({ profiles: [] });
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, "nested", "deep.md"), markdown("nested-agent", "rebuilt"));
      await writeFile(path, md("recreated"));
      await f.both({ profiles: [{ systemPrompt: "recreated" }] });
      await writeFile(join(root, "nested", "deep.md"), markdown("nested-agent", "edited"));
      await writeFile(path, md("final"));
      await f.both({ profiles: [{ systemPrompt: "final" }] });
      await f.a.prepareRuntimeState(f.workspace);
      await f.b.prepareRuntimeState(f.workspace);
      await f.both({ profiles: [{ name: "external", systemPrompt: "final" }] });
      await rm(join(root, "nested", "deep.md"));
      await writeFile(path, md("after-delete"));
      await f.both({ profiles: [{ name: "external", systemPrompt: "after-delete" }] });
    },
    20000,
  );

  it("recovers after deleting missing-path parents and after moving a replacement directory into place", async () => {
    const f = await pair(async (home) => {
      await mkdir(join(home, "workspace", ".zcode"), { recursive: true });
    });
    const root = join(f.workspace.workspacePath, ".zcode", "agents");
    // When the target is missing, even the temporarily watched empty parent directory can be moved away wholesale.
    await rename(
      join(f.workspace.workspacePath, ".zcode"),
      join(f.workspace.workspacePath, "saved"),
    );
    await mkdir(root, { recursive: true });
    const path = join(root, "a.md");
    await writeFile(path, markdown("aaa", "first"));
    await f.both({ profiles: [{ systemPrompt: "first" }] });
    await rm(f.workspace.workspacePath, { recursive: true });
    await f.both({ profiles: [] });
    await mkdir(root, { recursive: true });
    await writeFile(path, markdown("aaa", "rebuilt"));
    await f.both({ profiles: [{ systemPrompt: "rebuilt" }] });
    const replacement = join(f.homeDir, "replacement");
    await mkdir(replacement);
    await writeFile(join(replacement, "a.md"), markdown("aaa", "replacement"));
    await rm(root, { recursive: true });
    await rename(replacement, root);
    await f.both({ profiles: [{ systemPrompt: "replacement" }] });
    await writeFile(path, markdown("aaa", "later"));
    await f.both({ profiles: [{ systemPrompt: "later" }] });
  }, 25000);

  it("observes files created after an empty configuration directory is rebuilt", async () => {
    const f = await pair();
    const root = join(f.workspace.workspacePath, ".zcode", "agents");
    await mkdir(root, { recursive: true });
    const path = join(root, "a.md");
    await writeFile(path, markdown("aaa"));
    await f.both({ profiles: [{ name: "aaa" }] });
    await rm(root, { recursive: true });
    await f.both({ profiles: [] });
    await mkdir(root);
    await writeFile(path, markdown("aaa", "returned"));
    await f.both({ profiles: [{ systemPrompt: "returned" }] });
  }, 15000);

  it("reads state from the prepared path without re-resolving CLI storage on every event", async () => {
    const f = await pair();
    const { agent } = await f.a.createAgent({ config: config() });
    await f.both({ profiles: [{ name: "researcher" }] });
    const cliRoot = join(f.homeDir, ".zcode", "cli");
    await mkdir(cliRoot, { recursive: true });
    await writeFile(
      join(cliRoot, "config.json"),
      JSON.stringify({ storage: { dir: join(f.homeDir, "other-storage") } }),
    );
    const stateRoot = join(f.homeDir, ".zcode", "v2");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "agents-state.json"),
      JSON.stringify({ disabledAgentIds: [agent.id] }),
    );
    await f.both({ kind: "ready", profiles: [] });
  }, 15000);

  it.skipIf(process.platform === "win32")(
    "publishes initial fallback when state cannot be read, including its migration",
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), "subagent-initial-state-"));
      cleanup.push(() => rm(homeDir, { recursive: true, force: true }));
      const path = join(homeDir, ".zcode", "v2", "agents-state.json");
      await mkdir(join(homeDir, ".zcode", "v2"), { recursive: true });
      await writeFile(path, "{}");
      await chmod(path, 0o200);
      cleanup.push(() => chmod(path, 0o600));
      const service = createSubagentsService({ homeDir });
      cleanup.push(() => service.disposeAll());
      const workspace = { workspacePath: join(homeDir, "workspace") };
      await service.prepareRuntimeState(workspace);
      expect(await service.readRuntimeConfig(workspace)).toEqual({ kind: "built-in-fallback" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not publish a write rejected before disk mutation, but consumes a partially failed rename",
    async () => {
      const f = await pair();
      const { agent } = await f.a.createAgent({ config: config() });
      await f.both({ profiles: [{ name: "researcher" }] });
      await expect(f.a.createAgent({ config: config() })).rejects.toThrow();
      await f.both({ profiles: [{ systemPrompt: "old" }] });
      await f.a.setEnabled({ agentId: agent.id, enabled: false });
      await f.both({ profiles: [] });
      await f.a.setEnabled({ agentId: agent.id, enabled: true });
      await f.both({ profiles: [{ name: "researcher" }] });
      // Unreadable state makes the migration fail; the Markdown written beforehand is a real on-disk fact that the watcher still observes.
      const statePath = join(f.homeDir, ".zcode", "v2", "agents-state.json");
      await mkdir(join(f.homeDir, ".zcode", "v2"), { recursive: true });
      await writeFile(statePath, JSON.stringify({ disabledAgentIds: [] }));
      await chmod(statePath, 0);
      cleanup.push(() => chmod(statePath, 0o600));
      await expect(
        f.a.updateAgent({ agentId: agent.id, oldFilePath: agent.path, config: config("renamed") }),
      ).rejects.toThrow();
      await f.both({ kind: "built-in-fallback" });
      await chmod(statePath, 0o600);
      await writeFile(statePath, JSON.stringify({ disabledAgentIds: [] }));
      await f.both({ kind: "ready", profiles: [{ name: "renamed" }, { name: "researcher" }] });
    },
    15000,
  );

  it("observes an empty root moved away, an invalid file replacement, and directory recovery", async () => {
    const f = await pair(async (home) => {
      await mkdir(join(home, "workspace", ".zcode", "agents"), { recursive: true });
    });
    const root = join(f.workspace.workspacePath, ".zcode", "agents");
    await rename(root, root + "-saved");
    await writeFile(root, "not a directory");
    await f.both({ kind: "built-in-fallback" });
    await rm(root);
    await rename(root + "-saved", root);
    await writeFile(join(root, "researcher.md"), markdown("researcher", "restored"));
    await f.both({ kind: "ready", profiles: [{ systemPrompt: "restored" }] });
  }, 20000);
});
