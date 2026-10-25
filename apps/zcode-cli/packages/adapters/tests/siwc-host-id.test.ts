import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSiwcHostId } from "../src/auth/siwc/siwc-host-id.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "siwc-host-id-"));
  tempDirs.push(dir);
  return dir;
}

describe("SIWC host id manager", () => {
  it("creates a urn:uuid host id once and reuses it", async () => {
    const dir = await createTempDir();
    const first = await resolveSiwcHostId({
      baseDir: dir,
      generateUuid: () => "11111111-2222-3333-4444-555555555555",
    });
    expect(first.created).toBe(true);
    expect(first.hostId).toBe("urn:uuid:11111111-2222-3333-4444-555555555555");
    expect(first.path).toBe(join(dir, ".zcode", "v2", "siwc-host-id.txt"));

    const second = await resolveSiwcHostId({
      baseDir: dir,
      generateUuid: () => "99999999-9999-9999-9999-999999999999",
    });
    expect(second.created).toBe(false);
    expect(second.hostId).toBe(first.hostId);
  });

  it("writes the file with owner-only permissions", async () => {
    const dir = await createTempDir();
    const { path } = await resolveSiwcHostId({ baseDir: dir });
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("regenerates when the existing file is blank", async () => {
    const dir = await createTempDir();
    const path = join(dir, ".zcode", "v2", "siwc-host-id.txt");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "   \n", "utf-8");
    const result = await resolveSiwcHostId({
      baseDir: dir,
      generateUuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    expect(result.created).toBe(true);
    expect(await readFile(path, "utf-8")).toContain(
      "urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });

  it("resolves the path from ZCODE_DATA_BASE_DIR like the credential store", async () => {
    const dir = await createTempDir();
    const result = await resolveSiwcHostId({
      env: { ZCODE_DATA_BASE_DIR: dir },
      generateUuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    expect(result.path).toBe(join(dir, ".zcode", "v2", "siwc-host-id.txt"));
  });
});
