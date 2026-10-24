import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTrustedHostKey,
  defaultKnownHostsFiles,
  describeHostKey,
  lookupHostKey,
  orderServerHostKeyAlgorithms,
  verifyHostKey,
  type KnownHostsFiles,
} from "../src/remote/sshAuth.js";

function sshString(value: Buffer | string): Buffer {
  const data = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

// Fake host key blob in SSH wire format: string type + opaque random material. Never a real key.
function fakeKeyBlob(type = "ssh-ed25519"): Buffer {
  return Buffer.concat([sshString(type), sshString(randomBytes(32))]);
}

function line(names: string, blob: Buffer): string {
  const key = describeHostKey(blob);
  return `${names} ${key.keyType} ${key.publicKey}`;
}

function hashedName(name: string): string {
  const salt = randomBytes(20);
  const hash = createHmac("sha1", salt).update(name).digest();
  return `|1|${salt.toString("base64")}|${hash.toString("base64")}`;
}

describe("describeHostKey", () => {
  it("reports the key type and an unpadded SHA256 fingerprint like ssh-keygen -l", () => {
    const blob = fakeKeyBlob("ecdsa-sha2-nistp256");
    const key = describeHostKey(blob);
    expect(key.keyType).toBe("ecdsa-sha2-nistp256");
    expect(key.publicKey).toBe(blob.toString("base64"));
    const expected = createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "");
    expect(key.fingerprint).toBe(`SHA256:${expected}`);
  });
});

describe("lookupHostKey", () => {
  const blob = fakeKeyBlob();
  const key = describeHostKey(blob);

  it("unknown when no line names the host", () => {
    expect(lookupHostKey(line("other.example", blob), "dev.example", 22, key)).toEqual({
      kind: "unknown",
      knownKeyTypes: [],
    });
  });

  it("match when the host line carries the same key", () => {
    const content = `# comment\n\n${line("alias,dev.example", blob)} user@laptop\n`;
    expect(lookupHostKey(content, "dev.example", 22, key).kind).toBe("match");
  });

  it("changed when the host line carries a different key of the same type", () => {
    const content = line("dev.example", fakeKeyBlob());
    expect(lookupHostKey(content, "dev.example", 22, key).kind).toBe("changed");
  });

  it("a recorded key of another type is unknown, not changed, and reports the known types", () => {
    const content = line("dev.example", fakeKeyBlob("ssh-rsa"));
    expect(lookupHostKey(content, "dev.example", 22, key)).toEqual({
      kind: "unknown",
      knownKeyTypes: ["ssh-rsa"],
    });
  });

  it("a match wins over a stale line of the same type for the same host", () => {
    const content = [line("dev.example", fakeKeyBlob()), line("dev.example", blob)].join("\n");
    expect(lookupHostKey(content, "dev.example", 22, key).kind).toBe("match");
  });

  it("matches hashed |1| entries", () => {
    expect(lookupHostKey(line(hashedName("dev.example"), blob), "dev.example", 22, key).kind).toBe(
      "match",
    );
    expect(
      lookupHostKey(line(hashedName("[dev.example]:2222"), blob), "dev.example", 2222, key).kind,
    ).toBe("match");
    expect(lookupHostKey(line(hashedName("dev.example"), blob), "other", 22, key).kind).toBe(
      "unknown",
    );
  });

  it("[host]:port entries match only that port; port 22 also matches the bare host", () => {
    const content = line("[dev.example]:2222", blob);
    expect(lookupHostKey(content, "dev.example", 2222, key).kind).toBe("match");
    expect(lookupHostKey(content, "dev.example", 22, key).kind).toBe("unknown");
    expect(lookupHostKey(line("dev.example", blob), "dev.example", 2222, key).kind).toBe("unknown");
    expect(lookupHostKey(line("[dev.example]:22", blob), "dev.example", 22, key).kind).toBe(
      "match",
    );
  });

  it("supports wildcards and negation", () => {
    expect(lookupHostKey(line("*.example", blob), "dev.example", 22, key).kind).toBe("match");
    expect(lookupHostKey(line("dev?.example", blob), "dev1.example", 22, key).kind).toBe("match");
    expect(
      lookupHostKey(line("*.example,!dev.example", fakeKeyBlob()), "dev.example", 22, key).kind,
    ).toBe("unknown");
    expect(lookupHostKey(line("[*.example]:2222", blob), "dev.example", 2222, key).kind).toBe(
      "match",
    );
  });

  it("an @revoked line refuses the key for any host", () => {
    const content = [`@revoked ${line("*", blob)}`, line("dev.example", blob)].join("\n");
    expect(lookupHostKey(content, "dev.example", 22, key).kind).toBe("revoked");
  });

  it("ignores @cert-authority lines and malformed lines", () => {
    const content = [`@cert-authority ${line("dev.example", blob)}`, "garbage", "a b"].join("\n");
    expect(lookupHostKey(content, "dev.example", 22, key).kind).toBe("unknown");
  });
});

describe("known_hosts files", () => {
  let dir: string;
  let files: KnownHostsFiles;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zcode-known-hosts-"));
    files = { userFile: join(dir, ".ssh", "known_hosts"), globalFiles: [join(dir, "global")] };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("treats missing files as empty", async () => {
    const result = await verifyHostKey(files, "dev.example", 22, fakeKeyBlob());
    expect(result.lookup.kind).toBe("unknown");
  });

  it("reads the global file too", async () => {
    const blob = fakeKeyBlob();
    await writeFile(files.globalFiles[0]!, `${line("dev.example", blob)}\n`);
    expect((await verifyHostKey(files, "dev.example", 22, blob)).lookup.kind).toBe("match");
  });

  it("appends a plain line, creating ~/.ssh with 0700 and the file with 0600", async () => {
    const blob = fakeKeyBlob();
    const key = describeHostKey(blob);
    await expect(
      appendTrustedHostKey(files, { host: "dev.example", port: 2222, ...key }),
    ).resolves.toBe("appended");
    const content = await readFile(files.userFile, "utf8");
    expect(content).toBe(`[dev.example]:2222 ${key.keyType} ${key.publicKey}\n`);
    if (process.platform !== "win32") {
      expect((await stat(join(dir, ".ssh"))).mode & 0o777).toBe(0o700);
      expect((await stat(files.userFile)).mode & 0o777).toBe(0o600);
    }
    expect((await verifyHostKey(files, "dev.example", 2222, blob)).lookup.kind).toBe("match");
  });

  it("adds a newline before the entry when the file does not end with one", async () => {
    const blob = fakeKeyBlob();
    const key = describeHostKey(blob);
    await appendTrustedHostKey(files, { host: "seed.example", port: 22, ...key });
    await writeFile(files.userFile, "other.example ssh-rsa AAAA");
    await appendTrustedHostKey(files, { host: "dev.example", port: 22, ...key });
    expect(await readFile(files.userFile, "utf8")).toBe(
      `other.example ssh-rsa AAAA\ndev.example ${key.keyType} ${key.publicKey}\n`,
    );
  });

  it("is a no-op when the key is already trusted", async () => {
    const blob = fakeKeyBlob();
    const key = describeHostKey(blob);
    await appendTrustedHostKey(files, { host: "dev.example", port: 22, ...key });
    await expect(
      appendTrustedHostKey(files, { host: "dev.example", port: 22, ...key }),
    ).resolves.toBe("already-trusted");
    expect((await readFile(files.userFile, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("refuses to trust when a different key of the same type appeared meanwhile", async () => {
    await appendTrustedHostKey(files, {
      host: "dev.example",
      port: 22,
      ...describeHostKey(fakeKeyBlob()),
    });
    await expect(
      appendTrustedHostKey(files, {
        host: "dev.example",
        port: 22,
        ...describeHostKey(fakeKeyBlob()),
      }),
    ).rejects.toMatchObject({ code: "remote-host-key-changed" });
  });
});

describe("known_hosts trust across Hosts", () => {
  let dir: string;
  let files: KnownHostsFiles;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zcode-known-hosts-race-"));
    files = { userFile: join(dir, ".ssh", "known_hosts"), globalFiles: [] };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("two concurrent trusts of different same-type keys append only one", async () => {
    const first = describeHostKey(fakeKeyBlob());
    const second = describeHostKey(fakeKeyBlob());
    const results = await Promise.allSettled([
      appendTrustedHostKey(files, { host: "dev.example", port: 22, ...first }),
      appendTrustedHostKey(files, { host: "dev.example", port: 22, ...second }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: "appended" },
    ]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "remote-host-key-changed" },
    });
    expect((await readFile(files.userFile, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("two concurrent trusts of the same key write one line", async () => {
    const key = describeHostKey(fakeKeyBlob());
    const results = await Promise.all([
      appendTrustedHostKey(files, { host: "dev.example", port: 22, ...key }),
      appendTrustedHostKey(files, { host: "dev.example", port: 22, ...key }),
    ]);
    expect(results.sort()).toEqual(["already-trusted", "appended"]);
    expect((await readFile(files.userFile, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("waits for another Host's lock file and then re-reads before appending", async () => {
    // Another Host holds the lock and records a different key of the same type while we wait.
    const lockPath = `${files.userFile}.zcode-lock`;
    await mkdir(join(dir, ".ssh"), { recursive: true });
    await writeFile(lockPath, "other-host");
    const pending = appendTrustedHostKey(files, {
      host: "dev.example",
      port: 22,
      ...describeHostKey(fakeKeyBlob()),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await writeFile(files.userFile, `${line("dev.example", fakeKeyBlob())}\n`);
    await unlink(lockPath);
    await expect(pending).rejects.toMatchObject({ code: "remote-host-key-changed" });
  });

  it("runs the caller's guard under the lock right before writing and writes nothing when it throws", async () => {
    const guard = vi.fn(() => {
      throw new Error("trust no longer pending");
    });
    await expect(
      appendTrustedHostKey(
        files,
        { host: "dev.example", port: 22, ...describeHostKey(fakeKeyBlob()) },
        guard,
      ),
    ).rejects.toThrow("trust no longer pending");
    expect(guard).toHaveBeenCalledOnce();
    await expect(readFile(files.userFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("breaks a stale lock left by a crashed Host", async () => {
    const lockPath = `${files.userFile}.zcode-lock`;
    await mkdir(join(dir, ".ssh"), { recursive: true });
    await writeFile(lockPath, "crashed-host");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await expect(
      appendTrustedHostKey(files, {
        host: "dev.example",
        port: 22,
        ...describeHostKey(fakeKeyBlob()),
      }),
    ).resolves.toBe("appended");
  });
});

describe("defaultKnownHostsFiles", () => {
  it("reads OpenSSH's default user and system files on macOS and Linux", () => {
    const files = defaultKnownHostsFiles("linux", {}, "/home/alice");
    expect(files.userFile).toBe("/home/alice/.ssh/known_hosts");
    expect(files.globalFiles).toEqual([
      "/home/alice/.ssh/known_hosts2",
      "/etc/ssh/ssh_known_hosts",
      "/etc/ssh/ssh_known_hosts2",
    ]);
  });

  it("reads the system file under %ProgramData% on Windows", () => {
    const files = defaultKnownHostsFiles("win32", { ProgramData: "D:\\Data" }, "C:\\Users\\alice");
    expect(files.globalFiles).toEqual([
      win32.join("C:\\Users\\alice", ".ssh", "known_hosts2"),
      win32.join("D:\\Data", "ssh", "ssh_known_hosts"),
      win32.join("D:\\Data", "ssh", "ssh_known_hosts2"),
    ]);
    expect(defaultKnownHostsFiles("win32", {}, "C:\\Users\\alice").globalFiles[1]).toBe(
      win32.join("C:\\ProgramData", "ssh", "ssh_known_hosts"),
    );
  });
});

describe("orderServerHostKeyAlgorithms", () => {
  it("offers the recorded key types first and keeps every default algorithm", () => {
    const order = orderServerHostKeyAlgorithms(["ssh-rsa"]);
    expect(order.slice(0, 3)).toEqual(["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"]);
    expect(order).toContain("ssh-ed25519");
    expect(new Set(order).size).toBe(order.length);
  });

  it("returns undefined when nothing is recorded so ssh2 keeps its defaults", () => {
    expect(orderServerHostKeyAlgorithms([])).toBeUndefined();
  });
});
