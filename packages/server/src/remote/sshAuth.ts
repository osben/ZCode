import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ConnectConfig, ServerHostKeyAlgorithm } from "ssh2";
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
  /** The host key verifier refused the server key during this connect attempt. */
  hostKeyFailure?: SSHHostKeyFailure;
}

export function normalizeSSHConnectError(
  error: unknown,
  options: NormalizeSSHConnectErrorOptions = {},
): Error {
  if (options.hostKeyFailure) {
    // ssh2 reports a refused key as a generic handshake failure, so the code is stamped here. The message stays free of
    // host names and keys because connect errors are logged; the UI builds the copy from the code.
    const { hostKeyFailure } = options;
    const base =
      hostKeyFailure.kind === "changed"
        ? hostKeyChangedError()
        : Object.assign(new Error("SSH host key is not in known_hosts"), {
            code: "remote-host-key-unknown" satisfies PublicZCodeErrorCode,
            retryable: false,
          });
    // Non-enumerable: connect errors are passed to console.error, and util.inspect prints enumerable own properties.
    Object.defineProperty(base, "hostKey", { value: hostKeyFailure, enumerable: false });
    return Object.assign(base, { cause: error });
  }
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

// OpenSSH known_hosts handling for host key verification (specs/ssh-host-key-verification.md).

export interface KnownHostsFiles {
  /** Writable per-user file; the only file the app appends to. */
  userFile: string;
  /** Read-only system files. */
  globalFiles: readonly string[];
}

export interface ObservedHostKey {
  keyType: string;
  /** Base64 of the SSH wire-format key blob, as written in known_hosts. */
  publicKey: string;
  /** `SHA256:<unpadded base64>`, the format `ssh-keygen -l` prints. */
  fingerprint: string;
}

export interface HostKeyTrustRequest extends ObservedHostKey {
  host: string;
  port: number;
}

/** A refused server key, kept on the connect error so the Host can offer it for trust. Never logged. */
export interface SSHHostKeyFailure extends HostKeyTrustRequest {
  kind: "unknown" | "changed";
}

export type HostKeyLookup =
  | { kind: "match" }
  | { kind: "changed" }
  | { kind: "revoked" }
  | { kind: "unknown"; knownKeyTypes: string[] };

export function defaultKnownHostsFiles(): KnownHostsFiles {
  return {
    // homedir() resolves %USERPROFILE% on Windows, matching OpenSSH for Windows.
    userFile: join(homedir(), ".ssh", "known_hosts"),
    globalFiles: process.platform === "win32" ? [] : ["/etc/ssh/ssh_known_hosts"],
  };
}

export function describeHostKey(blob: Buffer): ObservedHostKey {
  const typeLength = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const keyType =
    typeLength > 0 && 4 + typeLength <= blob.length
      ? blob.subarray(4, 4 + typeLength).toString("latin1")
      : "unknown";
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "");
  return { keyType, publicKey: blob.toString("base64"), fingerprint: `SHA256:${digest}` };
}

interface KnownHostsLine {
  marker: "revoked" | "cert-authority" | undefined;
  hosts: string;
  keyType: string;
  publicKey: string;
}

function parseLine(raw: string): KnownHostsLine | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const fields = trimmed.split(/\s+/u);
  let marker: KnownHostsLine["marker"];
  if (fields[0]?.startsWith("@")) {
    const name = fields.shift();
    if (name === "@revoked") marker = "revoked";
    else if (name === "@cert-authority") marker = "cert-authority";
    else return undefined;
  }
  const [hosts, keyType, publicKey] = fields;
  if (!hosts || !keyType || !publicKey) return undefined;
  return { marker, hosts, keyType, publicKey };
}

/** Names OpenSSH would look up: the bare host for port 22, `[host]:port` otherwise. */
function lookupNames(host: string, port: number): string[] {
  const normalized = host.toLowerCase();
  return port === 22 ? [normalized, `[${normalized}]:22`] : [`[${normalized}]:${port}`];
}

function wildcardMatches(pattern: string, name: string): boolean {
  const source = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*")
    .replace(/\?/gu, ".");
  return new RegExp(`^${source}$`, "u").test(name);
}

function hashedMatches(entry: string, name: string): boolean {
  const [, , salt, hash] = entry.split("|");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hostListMatches(hosts: string, names: readonly string[]): boolean {
  if (hosts.startsWith("|1|")) return names.some((name) => hashedMatches(hosts, name));
  let matched = false;
  for (const pattern of hosts.split(",")) {
    if (!pattern) continue;
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (!names.some((name) => wildcardMatches(body, name))) continue;
    // A matching negated pattern excludes the whole line, as in OpenSSH.
    if (negated) return false;
    matched = true;
  }
  return matched;
}

export function lookupHostKey(
  content: string,
  host: string,
  port: number,
  key: ObservedHostKey,
): HostKeyLookup {
  const names = lookupNames(host, port);
  let sameTypeDiffers = false;
  const knownKeyTypes = new Set<string>();
  let matched = false;
  for (const raw of content.split(/\r?\n/u)) {
    const entry = parseLine(raw);
    if (!entry || entry.marker === "cert-authority") continue;
    const sameKey = entry.keyType === key.keyType && entry.publicKey === key.publicKey;
    if (entry.marker === "revoked") {
      if (sameKey) return { kind: "revoked" };
      continue;
    }
    if (!hostListMatches(entry.hosts, names)) continue;
    knownKeyTypes.add(entry.keyType);
    if (sameKey) matched = true;
    else if (entry.keyType === key.keyType) sameTypeDiffers = true;
  }
  if (matched) return { kind: "match" };
  if (sameTypeDiffers) return { kind: "changed" };
  return { kind: "unknown", knownKeyTypes: [...knownKeyTypes] };
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // Missing or unreadable files are empty, like OpenSSH.
    return "";
  }
}

async function readAllKnownHosts(files: KnownHostsFiles): Promise<string> {
  const contents = await Promise.all(
    [files.userFile, ...files.globalFiles].map((path) => readOptional(path)),
  );
  return contents.join("\n");
}

export async function verifyHostKey(
  files: KnownHostsFiles,
  host: string,
  port: number,
  blob: Buffer,
): Promise<{ key: ObservedHostKey; lookup: HostKeyLookup }> {
  const key = describeHostKey(blob);
  return { key, lookup: lookupHostKey(await readAllKnownHosts(files), host, port, key) };
}

export async function readKnownHostKeyTypes(
  files: KnownHostsFiles,
  host: string,
  port: number,
): Promise<string[]> {
  const lookup = lookupHostKey(await readAllKnownHosts(files), host, port, {
    keyType: "",
    publicKey: "",
    fingerprint: "",
  });
  return lookup.kind === "unknown" ? lookup.knownKeyTypes : [];
}

export function hostKeyChangedError(): Error {
  return Object.assign(new Error("SSH host key does not match known_hosts"), {
    code: "remote-host-key-changed" satisfies PublicZCodeErrorCode,
    retryable: false,
  });
}

/**
 * Persists a key the user accepted. The file is re-read first, so a concurrent edit that already recorded the key is a
 * no-op and one that recorded a different key of the same type is refused.
 */
export async function appendTrustedHostKey(
  files: KnownHostsFiles,
  request: HostKeyTrustRequest,
): Promise<"appended" | "already-trusted"> {
  const lookup = lookupHostKey(await readAllKnownHosts(files), request.host, request.port, request);
  if (lookup.kind === "match") return "already-trusted";
  if (lookup.kind !== "unknown") throw hostKeyChangedError();
  const name = request.port === 22 ? request.host : `[${request.host}]:${request.port}`;
  await mkdir(dirname(files.userFile), { recursive: true, mode: 0o700 });
  const existing = await readOptional(files.userFile);
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(
    files.userFile,
    `${separator}${name} ${request.keyType} ${request.publicKey}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return "appended";
}

const DEFAULT_SERVER_HOST_KEY_ALGORITHMS: readonly ServerHostKeyAlgorithm[] = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
  "ssh-rsa",
];

function algorithmsForKeyType(keyType: string): ServerHostKeyAlgorithm[] {
  // known_hosts records RSA keys as ssh-rsa; the signature algorithms below all use that key.
  if (keyType === "ssh-rsa") return ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"];
  return DEFAULT_SERVER_HOST_KEY_ALGORITHMS.filter((algorithm) => algorithm === keyType);
}

/**
 * Offers the key types already recorded for the host first, so a host known by its RSA or ECDSA key is not reported as
 * unknown just because ssh2 prefers ed25519. Returns undefined to keep ssh2's defaults when nothing is recorded.
 */
export function orderServerHostKeyAlgorithms(
  knownKeyTypes: readonly string[],
): ServerHostKeyAlgorithm[] | undefined {
  const preferred = knownKeyTypes.flatMap(algorithmsForKeyType);
  if (preferred.length === 0) return undefined;
  return [...new Set([...preferred, ...DEFAULT_SERVER_HOST_KEY_ALGORITHMS])];
}
