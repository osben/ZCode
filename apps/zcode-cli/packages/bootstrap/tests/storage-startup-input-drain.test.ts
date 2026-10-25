import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { prepareProtocolStartupStorage } from "../src/zcode-protocol/storage-startup.js";

// specs/storage-prep-worker-exit.md: in a Host Worker, a paused stdin keeps the worker's stdio port
// referenced, so the worker only exits when the 1 s exit watchdog fires.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function hostHandshake() {
  const input = new PassThrough();
  const frames: Array<{ method: string }> = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const frame = JSON.parse(line) as { method: string };
        frames.push(frame);
        // The Host acknowledges the storage path once, like storagePreparationProcesses.ts.
        if (frame.method === "startup/storagePath")
          input.write(`${JSON.stringify({ method: "startup/storagePathReady", reuse: false })}\n`);
      }
      callback();
    },
  });
  return { input, output, frames };
}

function endsWithin(stream: PassThrough, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    stream.once("end", () => {
      clearTimeout(timer);
      resolve(true);
    });
    // The Host ends its input after it reads startup/storagePrepared.
    stream.end();
  });
}

describe("storage preparation releases its input", () => {
  it("reads the input to its end after a successful preparation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-storage-drain-"));
    dirs.push(dir);
    const { input, output, frames } = hostHandshake();
    await prepareProtocolStartupStorage({ dbPath: join(dir, "db.sqlite"), input, output });
    expect(frames.at(-1)?.method).toBe("startup/storagePrepared");
    expect(await endsWithin(input, 200)).toBe(true);
  });

  it("reads the input to its end when preparation fails after the acknowledgement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-storage-drain-"));
    dirs.push(dir);
    const { input, output } = hostHandshake();
    // A directory is not a database file, so opening the store fails.
    await expect(prepareProtocolStartupStorage({ dbPath: dir, input, output })).rejects.toThrow();
    expect(await endsWithin(input, 200)).toBe(true);
  });
});
