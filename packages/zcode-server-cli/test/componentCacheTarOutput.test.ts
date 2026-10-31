import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // A tar child whose process exits before its stdout is drained, the order a loaded host produces.
    spawn: vi.fn((_command: string, args: readonly string[]) => {
      spawned.push([...args]);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      const output = args.includes("-tvzf")
        ? "drwxr-xr-x u/g 0 2026-10-31 00:00 ./\nlrwxrwxrwx u/g 0 2026-10-31 00:00 ./runtime -> /outside\n"
        : args.includes("-tzf")
          ? "./\n./runtime\n"
          : "";
      setImmediate(() => {
        child.emit("exit", 0, null);
        setImmediate(() => {
          child.stdout.end(output);
          child.stderr.end();
          setImmediate(() => child.emit("close", 0, null));
        });
      });
      return child;
    }),
  };
});

const { extractArchiveSafely } = await import("../src/runtime/componentCache.js");

describe("component archive listing", () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it("reads the whole tar listing before checking links, even when the process exits first", async () => {
    await expect(extractArchiveSafely("/archive/component.tar.gz", "/destination")).rejects.toThrow(
      /symbolic or hard link/i,
    );
    expect(spawned.some((args) => args.includes("-xzf"))).toBe(false);
  });
});
