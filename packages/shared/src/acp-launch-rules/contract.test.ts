import { describe, expect, it } from "vitest";
import {
  ACP_LAUNCH_LIMITS,
  describeAcpArgsProblem,
  describeAcpCommandProblem,
  describeAcpEnvProblem,
  describeAcpLaunchProblem,
  isAcpLoaderInjectionEnvKey,
} from "./contract.js";

describe("ACP launch rules", () => {
  it("accepts ordinary commands, args and env", () => {
    expect(
      describeAcpLaunchProblem({
        command: "/Applications/Cursor Agent/bin/cursor-agent",
        args: ["acp", "--flag=value with spaces"],
        env: { OPENCODE_CONFIG: "/tmp/x", MULTI_LINE_CERT: "a\nb", SSH_AUTH_SOCK: undefined },
      }),
    ).toBeNull();
  });

  it("rejects line breaks and NUL in the command", () => {
    expect(describeAcpCommandProblem("opencode\nZCODE_ACP_LOGIN_BANNER\ntouch /tmp/x")).toMatch(
      /CR or LF/,
    );
    expect(describeAcpCommandProblem("opencode\rx")).toMatch(/CR or LF/);
    expect(describeAcpCommandProblem("open\0code")).toMatch(/NUL/);
    expect(describeAcpCommandProblem("   ")).toMatch(/non-empty/);
    expect(describeAcpCommandProblem("x".repeat(ACP_LAUNCH_LIMITS.command + 1))).toMatch(/exceeds/);
  });

  it("rejects line breaks, NUL, oversize and too many args", () => {
    expect(describeAcpArgsProblem(["acp", "a\nb"])).toMatch(/CR or LF/);
    expect(describeAcpArgsProblem(["\0"])).toMatch(/NUL/);
    expect(describeAcpArgsProblem([1])).toMatch(/string/);
    expect(describeAcpArgsProblem("acp")).toMatch(/array/);
    expect(
      describeAcpArgsProblem(Array.from({ length: ACP_LAUNCH_LIMITS.args + 1 }, () => "a")),
    ).toMatch(/at most/);
  });

  it("rejects setting loader/injection env keys but allows deleting them", () => {
    for (const key of [
      "LD_PRELOAD",
      "ld_library_path",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "BASH_ENV",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "PYTHONHOME",
      "PERL5OPT",
      "PERL5LIB",
      "RUBYOPT",
      "RUBYLIB",
      "JAVA_TOOL_OPTIONS",
      "_JAVA_OPTIONS",
      "ZDOTDIR",
      "ENV",
      "BASH_FUNC_my_fn",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_EXEC_PATH",
      "GIT_ASKPASS",
      "GIT_PROXY_COMMAND",
    ]) {
      expect(isAcpLoaderInjectionEnvKey(key)).toBe(true);
      expect(describeAcpEnvProblem({ [key]: "x" })).toMatch(/loader/);
      expect(describeAcpEnvProblem({ [key]: undefined })).toBeNull();
    }
    expect(isAcpLoaderInjectionEnvKey("OLD_PRELOAD")).toBe(false);
    expect(isAcpLoaderInjectionEnvKey("NODE_PATH")).toBe(false);
    expect(isAcpLoaderInjectionEnvKey("GIT_AUTHOR_NAME")).toBe(false);
    expect(isAcpLoaderInjectionEnvKey("PYTHONUNBUFFERED")).toBe(false);
  });

  it("rejects invalid env names, NUL values and too many pairs", () => {
    expect(describeAcpEnvProblem({ "1BAD": "x" })).toMatch(/valid environment name/);
    expect(describeAcpEnvProblem({ GOOD: "a\0b" })).toMatch(/NUL/);
    const many = Object.fromEntries(
      Array.from({ length: ACP_LAUNCH_LIMITS.envPairs + 1 }, (_, i) => [`K${i}`, "v"]),
    );
    expect(describeAcpEnvProblem(many)).toMatch(/at most/);
  });
});
