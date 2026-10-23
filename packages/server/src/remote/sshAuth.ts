import type { ConnectConfig } from "ssh2";
import type { PublicZCodeErrorCode } from "@zcode/shared";

export const SSH_READY_TIMEOUT_MS = 60_000;
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSH_KEEPALIVE_COUNT_MAX = 3;

interface SSHConnectConfigInput {
  host: string;
  port?: number;
  username: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  password?: string;
  agent?: string;
}

function isMissingPrivateKeyPassphraseMessage(message: string): boolean {
  return /encrypted .*private .*key detected, but no passphrase given/i.test(message);
}

function isInvalidPrivateKeyPassphraseMessage(message: string): boolean {
  return /(bad passphrase|key integrity check failed|unable to authenticate data)/i.test(message);
}

export function buildSSHConnectConfig(input: SSHConnectConfigInput): ConnectConfig {
  const hasPassword = typeof input.password === "string" && input.password.length > 0;

  // If SSH_AUTH_SOCK is always included for password login, ssh2 tries agent public keys first.
  // On hosts with a low MaxAuthTries, authentication attempts may be exhausted during the public-key phase before the correct password is tried.
  // Enable the agent only when it is explicitly provided; password mode otherwise disables the implicit agent.
  const resolvedAgent = input.agent ?? (hasPassword ? undefined : process.env["SSH_AUTH_SOCK"]);

  return {
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
    password: hasPassword ? input.password : undefined,
    agent: resolvedAgent,
    // ssh2's default readyTimeout is 20s, which can falsely time out on weak public networks or during server jitter.
    // Explicitly extend the connection handshake timeout to allow genuinely slow connections and keep error normalization aligned with actual configuration.
    readyTimeout: SSH_READY_TIMEOUT_MS,
    // If an idle SSH project is silently disconnected by NAT, a firewall, or the server, the stdio channel may not close immediately.
    // Enable SSH-level keepalive so ssh2 emits error/close after repeated missed responses instead of leaving UI tasks stuck loading.
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    // Some SSH servers enable only keyboard-interactive (challenge-response) and disable plain password authentication.
    // Enabling tryKeyboard with an interaction callback lets the same password work on these hosts, avoiding cases where CLI login works but app authentication fails.
    tryKeyboard: hasPassword,
  };
}

// Prompts that ask for a second factor (one-time code, OTP, MFA). Matched against the name, instructions and each prompt.
const VERIFICATION_PROMPT_PATTERN =
  /verification code|one[- ]?time|\bOTP\b|pass ?code|(?:second|two|2nd)[- ]?factor|\b(?:2FA|MFA)\b|authenticator|动态口令|动态密码/iu;

export function createKeyboardInteractiveResponder(
  password?: string,
  onAdditionalVerification?: () => void,
) {
  return (
    name: string,
    instructions: string,
    _lang: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (responses: string[]) => void,
  ) => {
    if (!password || prompts.length === 0) {
      finish([]);
      return;
    }

    // Record the request for the connect error path; the password is still sent so password-only prompts keep working.
    if (
      [name, instructions, ...prompts.map(({ prompt }) => prompt)].some((text) =>
        VERIFICATION_PROMPT_PATTERN.test(text),
      )
    ) {
      onAdditionalVerification?.();
    }

    finish(prompts.map(() => password));
  };
}

export interface NormalizeSSHConnectErrorOptions {
  /** The session had reached ready before the error; keepalive timeouts then mean the link dropped. */
  established?: boolean;
  /** The server asked a second-factor keyboard-interactive prompt during this connect attempt. */
  additionalVerificationPrompted?: boolean;
}

export function normalizeSSHConnectError(
  error: unknown,
  options: NormalizeSSHConnectErrorOptions = {},
): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-authentication"
  ) {
    if (options.additionalVerificationPrompted) {
      // The server accepted the password and then asked for a second factor. The password path cannot answer it,
      // so report a distinct code instead of the generic credential-check message.
      return Object.assign(
        new Error(
          "SSH 认证失败：服务器在密码之后还要求额外验证（例如动态口令），当前不支持，请改用私钥或 SSH agent 登录",
          { cause: error },
        ),
        { code: "remote-authentication-unsupported" satisfies PublicZCodeErrorCode },
      );
    }
    return authenticationError("SSH 认证失败：请检查用户名、密码或私钥配置", error);
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-timeout"
  ) {
    if (options.established) {
      return new Error(
        `SSH 连接无响应：约 ${SSH_READY_TIMEOUT_MS / 1000} 秒没有收到服务器的心跳响应，连接已断开，请检查网络或服务器状态`,
        { cause: error },
      );
    }
    return new Error(
      `SSH 连接握手超时：未能在 ${SSH_READY_TIMEOUT_MS / 1000} 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异`,
    );
  }

  if (error instanceof Error) {
    // ssh2 returns different messages for different private-key formats (old/new OpenSSH formats, PPK).
    // Matching only one string previously leaked raw errors for some missing-passphrase/incorrect-passphrase cases, leaving users unsure which credential to enter.
    // Normalize by patterns so these errors map consistently to product-level guidance users can act on.
    if (isMissingPrivateKeyPassphraseMessage(error.message)) {
      return authenticationError("SSH 私钥需要口令：检测到加密私钥，但当前未提供私钥口令", error);
    }
    if (isInvalidPrivateKeyPassphraseMessage(error.message)) {
      return authenticationError("SSH 私钥口令错误：无法解密私钥，请检查私钥口令是否正确", error);
    }
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error("SSH 连接失败");
}

function authenticationError(message: string, cause: unknown): Error {
  // 认证发生在懒连接的 probe 内；在仍有 ssh2 结构化原因的边界定码，避免被归成预检失败。
  return Object.assign(new Error(message, { cause }), {
    code: "remote-authentication-failed" satisfies PublicZCodeErrorCode,
  });
}
