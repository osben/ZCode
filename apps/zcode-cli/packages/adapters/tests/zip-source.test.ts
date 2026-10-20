import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveZipPluginSource } from "../src/plugins/zip-source.js";

const openServers: Server[] = [];
const openCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of openCleanups.splice(0).reverse()) {
    await cleanup().catch(() => {});
  }
  for (const server of openServers.splice(0).reverse()) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a stored (uncompressed) zip so tests control the Unix mode of every entry. */
function createStoredZip(entries: Array<{ content: string; path: string; mode?: number }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = Buffer.from(entry.content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    // mode 0 means "no Unix attributes" (zips produced without them); other modes are archived verbatim.
    const externalAttributes = (entry.mode ?? 0o100644) * 0x10000;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function startZipFixtureServer(routes: Record<string, Buffer>): Promise<string> {
  const server = createServer((request, response) => {
    const body = routes[new URL(request.url ?? "/", "http://127.0.0.1").pathname];
    if (!body) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-length": String(body.byteLength),
      "content-type": "application/zip",
    });
    response.end(body);
  });
  openServers.push(server);
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("fixture server did not report a port"));
    });
  });
  return `http://127.0.0.1:${port}`;
}

describe("zip plugin source extraction", () => {
  // Root cause: extractZipArchive dropped the zip entries' Unix permission bits, so plugin hook
  // executables shipped in marketplace zips (for example superpowers' run-hook.cmd) were extracted
  // non-executable and every hook spawn failed with EACCES/exit 126 (115 hook.run.failed events on
  // 2026-10-19). See specs/plugin-zip-executable-bits.md.
  it("preserves archived executable bits and leaves modeless entries at the platform default", async () => {
    const zipBuffer = createStoredZip([
      {
        path: "exec-plugin-1.0.0/hooks/run-hook.cmd",
        content: "#!/bin/sh\necho ok\n",
        mode: 0o100755,
      },
      {
        path: "exec-plugin-1.0.0/.claude-plugin/plugin.json",
        content: JSON.stringify({ name: "exec-plugin", version: "1.0.0" }),
        mode: 0o100644,
      },
      {
        path: "exec-plugin-1.0.0/assets/no-unix-attrs.txt",
        content: "created by a zip writer without Unix attributes\n",
        mode: 0,
      },
    ]);
    const baseUrl = await startZipFixtureServer({ "/exec-plugin.zip": zipBuffer });

    const source = await resolveZipPluginSource({
      sha256: createHash("sha256").update(zipBuffer).digest("hex"),
      stripRoot: true,
      url: `${baseUrl}/exec-plugin.zip`,
    });
    openCleanups.push(source.cleanup);

    const executableStat = await stat(join(source.path, "hooks", "run-hook.cmd"));
    expect(executableStat.mode & 0o777).toBe(0o755);

    const regularStat = await stat(join(source.path, ".claude-plugin", "plugin.json"));
    expect(regularStat.mode & 0o111).toBe(0);

    const modelessStat = await stat(join(source.path, "assets", "no-unix-attrs.txt"));
    expect(modelessStat.mode & 0o111).toBe(0);

    await source.cleanup();
  });
});
