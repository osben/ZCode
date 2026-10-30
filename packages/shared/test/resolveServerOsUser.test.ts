import { describe, expect, it, vi } from "vitest";

const passwdMissingError = () => {
  const error = new Error("uv_os_get_passwd returned ENOENT") as Error & {
    info: { code: string; syscall: string };
  };
  error.info = { code: "ENOENT", syscall: "uv_os_get_passwd" };
  return error;
};

async function resolveWith(userInfoImpl: () => { username: string }, geteuid?: () => number) {
  vi.resetModules();
  vi.doMock("node:os", () => ({ userInfo: userInfoImpl }));
  const geteuidBackup = process.geteuid;
  if (geteuid) process.geteuid = geteuid;
  try {
    const { resolveServerOsUser } = await import("../src/node.js");
    return resolveServerOsUser();
  } finally {
    if (geteuid) process.geteuid = geteuidBackup;
    vi.doUnmock("node:os");
  }
}

describe("resolveServerOsUser", () => {
  it("returns the passwd username when available", async () => {
    await expect(resolveWith(() => ({ username: "svc-runner" }))).resolves.toBe("svc-runner");
  });

  it("falls back to the numeric UID when passwd has no entry", async () => {
    const thrower = () => {
      throw passwdMissingError();
    };
    await expect(resolveWith(thrower, () => 1000)).resolves.toBe("uid:1000");
  });

  it("rethrows unrelated userInfo failures", async () => {
    const thrower = () => {
      throw new Error("boom");
    };
    await expect(resolveWith(thrower)).rejects.toThrow("boom");
  });
});
