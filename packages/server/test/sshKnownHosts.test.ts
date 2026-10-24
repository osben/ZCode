import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTrustedHostKey,
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
