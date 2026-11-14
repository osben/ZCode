// Fork: the Node purge against the session runtime presence rows the Rust agent writes
// (specs/fork-rust-agent-parity.md "Session runtime presence on the shared database"). The insert is
// the statement zcode-rs runs (`node-store/src/presence.rs` includes the same file).
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionId } from "@zcode/contracts";
import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

const RUST_INSERT = new URL(
  "../../../../../packages/rust-cli/crates/node-store/src/fixtures/runtime_presence_insert.sql",
  import.meta.url,
);
const ROOT = "sess_rust_open" as SessionId;

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A live process standing in for zcode-rs: Node probes only its pid. */
async function liveProcess(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "fork-rust-presence-"));
  roots.push(root);
  const dbPath = join(root, "db.sqlite");
  const store = await SqliteSessionStore.open({ dbPath });
  await store.createSession({
    id: ROOT,
    projectID: "project" as never,
    slug: ROOT,
    directory: "/work/example",
    title: ROOT,
    version: "1",
  });
  // zcode-rs's own connection to the shared database.
  const rust = new DatabaseSync(dbPath, { timeout: 1_000 });
  const insert = (await readFile(RUST_INSERT, "utf8")).trim();
  const register = (pid: number) => {
    const owner = `${pid}:${randomUUID()}`;
    rust.prepare(insert).run(ROOT, owner, pid);
    return owner;
  };
  return { store, rust, register };
}

describe("Node purge against Rust runtime presence rows", () => {
  it("refuses while the Rust process is alive and goes through once it is gone", async () => {
    const { store, rust, register } = await setup();
    try {
      const agent = await liveProcess();
      register(agent.pid!);

      const preview = await store.inspectSessionDeletion(ROOT);
      expect(preview.foreignRuntime).toBe(true);
      await expect(
        store.beginSessionDeletion(ROOT, preview.revision, "operation", []),
      ).rejects.toThrow("session-data.running");
      expect(rust.prepare("select count(*) as n from session_purge").get()).toEqual({ n: 0 });

      // A crashed agent: the probe sees ESRCH and deletes the row itself.
      agent.kill("SIGKILL");
      await exited(agent);
      const after = await store.inspectSessionDeletion(ROOT);
      expect(after.foreignRuntime).toBe(false);
      expect(
        rust.prepare("select count(*) as n from session_runtime_presence").get(),
      ).toEqual({ n: 0 });
      await store.beginSessionDeletion(ROOT, after.revision, "operation", []);

      // The next Rust open is refused by the insert guard.
      expect(() => register(process.pid)).toThrow("session-data.deleting");
    } finally {
      rust.close();
      store.close();
    }
  });

  it("does not treat the Rust rows as its own and its close leaves them", async () => {
    const { store, rust, register } = await setup();
    let closed = false;
    try {
      // Same pid as this Node process, different owner: still a foreign runtime.
      const owner = register(process.pid);
      const preview = await store.inspectSessionDeletion(ROOT);
      expect(preview.foreignRuntime).toBe(true);
      expect(preview.localRuntimeIds).toEqual([]);
      await expect(
        store.beginSessionDeletion(ROOT, preview.revision, "operation", []),
      ).rejects.toThrow("session-data.running");
      store.close();
      closed = true;
      expect(
        rust.prepare("select owner_id from session_runtime_presence").all(),
      ).toEqual([{ owner_id: owner }]);
    } finally {
      rust.close();
      // Node's close() is not idempotent: close here only when the test did not.
      if (!closed) store.close();
    }
  });
});
