import { afterEach, describe, expect, it } from "vitest";
import { normalizeRemoteConnectionError, publicZCodeErrorCodeSchema } from "@zcode/shared";
import {
  buildSSHConnectConfig,
  createKeyboardInteractiveResponder,
  normalizeSSHConnectError,
} from "../src/remote/sshAuth.js";

const originalAuthSock = process.env["SSH_AUTH_SOCK"];

afterEach(() => {
  if (originalAuthSock == null) {
    delete process.env["SSH_AUTH_SOCK"];
    return;
  }
  process.env["SSH_AUTH_SOCK"] = originalAuthSock;
});

describe("sshAuth", () => {
  it("密码登录时默认禁用隐式 agent，并启用 keyboard-interactive", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      password: "secret",
    });

    expect(config.agent).toBeUndefined();
    expect(config.tryKeyboard).toBe(true);
    expect(config.password).toBe("secret");
  });

  it("无密码时保留隐式 agent", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
    });

    expect(config.agent).toBe("/tmp/test.sock");
    expect(config.tryKeyboard).toBe(false);
  });

  it("显式传入 agent 时应覆盖默认策略", () => {
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      password: "secret",
      agent: "/tmp/custom.sock",
    });

    expect(config.agent).toBe("/tmp/custom.sock");
  });

  it("连接配置应显式设置 readyTimeout 和 keepalive，避免静默断连长期悬挂", () => {
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
    });

    expect(config.readyTimeout).toBe(60_000);
    expect(config.keepaliveInterval).toBe(15_000);
    expect(config.keepaliveCountMax).toBe(3);
  });

  it("私钥口令只用于解密私钥，不应改变密码登录分支判断", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      privateKey: "test-private-key",
      passphrase: "key-secret",
    });

    expect(config.passphrase).toBe("key-secret");
    expect(config.agent).toBe("/tmp/test.sock");
    expect(config.tryKeyboard).toBe(false);
    expect(config.password).toBeUndefined();
  });

  it("keyboard-interactive 回调应使用同一密码响应全部 prompt", () => {
    const responder = createKeyboardInteractiveResponder("secret");
    let responses: string[] = [];
    responder(
      "",
      "",
      "",
      [
        { prompt: "Password:", echo: false },
        { prompt: "OTP:", echo: false },
      ],
      (nextResponses) => {
        responses = nextResponses;
      },
    );

    expect(responses).toEqual(["secret", "secret"]);
  });

  it("client-authentication 错误应转换为可读信息", () => {
    const error = normalizeSSHConnectError({ level: "client-authentication" });
    expect(error.message).toContain("SSH 认证失败");
  });

  it.each([
    Object.assign(new Error("authentication wording may change"), {
      level: "client-authentication",
    }),
    Object.assign(new Error("Permission denied"), { level: "client-authentication" }),
    new Error("OpenSSH key integrity check failed -- bad passphrase?"),
    new Error("Encrypted private OpenSSH key detected, but no passphrase given"),
  ])("认证错误经过预检仍保留公开认证码及原始 cause", (cause) => {
    const error = normalizeSSHConnectError(cause);
    expect(error.cause).toBe(cause);
    const failure = normalizeRemoteConnectionError(error, "preflight");
    expect(failure.code).toBe("remote-authentication-failed");
    expect(publicZCodeErrorCodeSchema.parse(failure.code)).toBe(failure.code);
  });

  it("文件权限错误不被认证分类吞掉", () => {
    const error = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    expect(normalizeRemoteConnectionError(normalizeSSHConnectError(error), "preflight").code).toBe(
      "remote-permission-denied",
    );
  });

  it("client-timeout 错误应说明是 SSH 连接握手超时", () => {
    const error = normalizeSSHConnectError({ level: "client-timeout" });
    expect(error.message).toBe(
      "SSH 连接握手超时：未能在 60 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异",
    );
  });

  it("已建立会话后的 client-timeout 应说明是心跳无响应而非握手超时", () => {
    const error = normalizeSSHConnectError({ level: "client-timeout" }, { established: true });
    expect(error.message).toBe(
      "SSH 连接无响应：约 60 秒没有收到服务器的心跳响应，连接已断开，请检查网络或服务器状态",
    );
  });

  it("密码之后仍要求额外验证时应报告 remote-authentication-unsupported 并保留 cause", () => {
    const cause = { level: "client-authentication" };
    const error = normalizeSSHConnectError(cause, { additionalVerificationPrompted: true });
    expect(error.message).toBe(
      "SSH 认证失败：服务器在密码之后还要求额外验证（例如动态口令），当前不支持，请改用私钥或 SSH agent 登录",
    );
    expect(error.cause).toBe(cause);
    expect(Reflect.get(error, "code")).toBe("remote-authentication-unsupported");
    const failure = normalizeRemoteConnectionError(error, "preflight");
    expect(failure.code).toBe("remote-authentication-unsupported");
  });

  it("未观察到额外验证时认证失败仍保持 remote-authentication-failed", () => {
    const error = normalizeSSHConnectError(
      { level: "client-authentication" },
      { additionalVerificationPrompted: false },
    );
    expect(Reflect.get(error, "code")).toBe("remote-authentication-failed");
  });

  it.each([
    "Enter verification code",
    "One-time password",
    "Please enter the OTP",
    "Passcode",
    "Second factor required",
    "2FA token",
    "MFA challenge",
    "Authenticator app code",
    "请输入动态口令",
    "动态密码",
  ])("keyboard-interactive 提示 %s 应视为额外验证并仍用密码响应", (prompt) => {
    let verificationRequested = 0;
    const responder = createKeyboardInteractiveResponder("secret", () => {
      verificationRequested += 1;
    });
    let responses: string[] = [];
    responder("", "", "", [{ prompt, echo: true }], (next) => {
      responses = next;
    });
    expect(verificationRequested).toBe(1);
    expect(responses).toEqual(["secret"]);
  });

  it("普通密码提示不应触发额外验证回调", () => {
    let verificationRequested = false;
    const responder = createKeyboardInteractiveResponder("secret", () => {
      verificationRequested = true;
    });
    responder("", "", "", [{ prompt: "Password:", echo: false }], () => undefined);
    expect(verificationRequested).toBe(false);
  });

  it("没有密码或没有 prompt 时不应调用额外验证回调且返回空响应", () => {
    let verificationRequested = false;
    const callback = () => {
      verificationRequested = true;
    };
    let responses: string[] | undefined;
    createKeyboardInteractiveResponder(undefined, callback)(
      "",
      "",
      "",
      [{ prompt: "OTP:", echo: true }],
      (next) => {
        responses = next;
      },
    );
    expect(responses).toEqual([]);
    createKeyboardInteractiveResponder("secret", callback)("", "", "", [], (next) => {
      responses = next;
    });
    expect(responses).toEqual([]);
    expect(verificationRequested).toBe(false);
  });

  it("私钥缺少口令的错误文案变体应统一转换为可读提示", () => {
    const expectedMessage = "SSH 私钥需要口令：检测到加密私钥，但当前未提供私钥口令";
    const cases = [
      "Encrypted private OpenSSH key detected, but no passphrase given",
      "Encrypted OpenSSH private key detected, but no passphrase given",
      "Encrypted PPK private key detected, but no passphrase given",
    ];

    for (const message of cases) {
      expect(normalizeSSHConnectError(new Error(message)).message).toBe(expectedMessage);
    }
  });

  it("私钥口令错误应转换为可读提示", () => {
    const expectedMessage = "SSH 私钥口令错误：无法解密私钥，请检查私钥口令是否正确";
    const cases = [
      "OpenSSH key integrity check failed -- bad passphrase?",
      "PPK private key integrity check failed -- bad passphrase?",
    ];

    for (const message of cases) {
      expect(normalizeSSHConnectError(new Error(message)).message).toBe(expectedMessage);
    }
  });
});
