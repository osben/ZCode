import { describe, expect, it } from "vitest";
import { buildChildEnv, validateLaunchOptions, type AcpLaunchOptions } from "../src/index.js";

const validLaunch = (overrides: Partial<AcpLaunchOptions> = {}): AcpLaunchOptions => ({
  agentId: "mock",
  command: "opencode",
  args: ["acp"],
  cwd: "/tmp",
  ...overrides,
});

const captureError = (run: () => unknown): { code?: string; message: string } => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected the call to throw");
};

describe("validateLaunchOptions", () => {
  it("accepts and normalizes a valid launch definition", () => {
    const result = validateLaunchOptions(validLaunch({ command: "  opencode  " }));
    expect(result.command).toBe("opencode");
    expect(result.args).toEqual(["acp"]);
  });

  it("rejects blank commands", () => {
    const error = captureError(() => validateLaunchOptions(validLaunch({ command: "   " })));
    expect(error.code).toBe("ACP_INVALID_LAUNCH");
  });

  it("rejects NUL characters in command, args and cwd", () => {
    expect(
      captureError(() => validateLaunchOptions(validLaunch({ command: "bad\0cmd" }))).code,
    ).toBe("ACP_INVALID_LAUNCH");
    expect(
      captureError(() => validateLaunchOptions(validLaunch({ args: ["ok", "bad\0"] }))).code,
    ).toBe("ACP_INVALID_LAUNCH");
    expect(captureError(() => validateLaunchOptions(validLaunch({ cwd: "/tmp/bad\0" }))).code).toBe(
      "ACP_INVALID_LAUNCH",
    );
  });

  it("rejects too many args and non-string args", () => {
    const tooMany = Array.from({ length: 33 }, (_, index) => `arg-${index}`);
    expect(captureError(() => validateLaunchOptions(validLaunch({ args: tooMany }))).code).toBe(
      "ACP_INVALID_LAUNCH",
    );
    const notStrings = ["ok", 42] as unknown as string[];
    expect(captureError(() => validateLaunchOptions(validLaunch({ args: notStrings }))).code).toBe(
      "ACP_INVALID_LAUNCH",
    );
  });

  it("rejects invalid env keys and oversized env maps", () => {
    const badKey = { "1BAD": "x" };
    expect(captureError(() => validateLaunchOptions(validLaunch({ env: badKey }))).code).toBe(
      "ACP_INVALID_LAUNCH",
    );
    const tooManyPairs: Record<string, string> = {};
    for (let index = 0; index < 65; index += 1) tooManyPairs[`VAR_${index}`] = "x";
    expect(captureError(() => validateLaunchOptions(validLaunch({ env: tooManyPairs }))).code).toBe(
      "ACP_INVALID_LAUNCH",
    );
  });

  it("rejects relative cwd", () => {
    expect(
      captureError(() => validateLaunchOptions(validLaunch({ cwd: "relative/path" }))).code,
    ).toBe("ACP_INVALID_LAUNCH");
  });
});

describe("buildChildEnv", () => {
  it("scrubs secret-named and privileged ZCode variables, keeping the rest", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      EDITOR: "vim",
      MONKEY: "banana",
      TOKENIZER_MODE: "on",
      OPENAI_API_KEY: "***",
      GH_TOKEN: "***",
      DB_PASSWORD: "***",
      MY_SECRET: "***",
      PLAIN_CREDENTIAL: "cred",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/broker.sock",
      ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY: "authority",
      EMPTY_VALUE: undefined,
    };
    const env = buildChildEnv(parent);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.EDITOR).toBe("vim");
    // Segment matching must not over-scrub innocent substrings.
    expect(env.MONKEY).toBe("banana");
    expect(env.TOKENIZER_MODE).toBe("on");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.MY_SECRET).toBeUndefined();
    expect(env.PLAIN_CREDENTIAL).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    // Privileged ZCode runtime boundary, shared with every other subprocess.
    expect(env.ZCODE_CUA_PERMISSION_BROKER_SOCKET).toBeUndefined();
    expect(env.ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY).toBeUndefined();
    expect("EMPTY_VALUE" in env).toBe(false);
  });

  it("applies explicit overrides: set, re-introduce scrubbed names, delete", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      EDITOR: "vim",
      MY_SECRET: "***",
    };
    const env = buildChildEnv(parent, {
      MY_SECRET: "explicit",
      NEW_VAR: "1",
      EDITOR: undefined,
    });
    expect(env.MY_SECRET).toBe("explicit");
    expect(env.NEW_VAR).toBe("1");
    expect(env.EDITOR).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("keeps user capability sockets by design and supports the per-launch opt-out", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      KRB5CCNAME: "FILE:/tmp/krb5cc",
      GPG_AGENT_INFO: "/tmp/gpg-agent:0:1",
    };
    const env = buildChildEnv(parent);
    // Parity with ZCode's own runtime tooling: the agent is expected to use
    // git/ssh, gpg and Kerberos facilities for the tasks the user assigns.
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    expect(env.KRB5CCNAME).toBe("FILE:/tmp/krb5cc");
    expect(env.GPG_AGENT_INFO).toBe("/tmp/gpg-agent:0:1");
    const lean = buildChildEnv(parent, {
      SSH_AUTH_SOCK: undefined,
      GPG_AGENT_INFO: undefined,
    });
    expect("SSH_AUTH_SOCK" in lean).toBe(false);
    expect("GPG_AGENT_INFO" in lean).toBe(false);
    expect(lean.KRB5CCNAME).toBe("FILE:/tmp/krb5cc");
  });
});
