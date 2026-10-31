/* eslint-disable max-lines -- The SSH backend keeps connection, exec, SFTP upload, and fallback-progress flows together to avoid remote-connection regressions from splitting them. */
import { Client as SSHClient } from "ssh2";
import type { ConnectConfig } from "ssh2";
import { createReadStream } from "node:fs";
import type { Duplex } from "node:stream";
import { posix } from "node:path";
import { Emitter } from "@zcode/rpc";
import { resolveZCodeRuntimeEnv } from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteDisconnectEvent,
  RemoteDisconnectReason,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";
import {
  createCloseEventController,
  resolveRemoteExitCode,
} from "@zcode/server/remote/closeEvent.js";
import {
  buildPosixShellExecCommand,
  quotePosixShellArg,
  resolvePosixHomePath,
} from "@zcode/server/remote/posixShell.js";
import {
  buildSSHConnectConfig,
  createKeyboardInteractiveResponder,
  normalizeSSHConnectError,
} from "@zcode/server/remote/sshAuth.js";
import {
  defaultKnownHostsFiles,
  orderServerHostKeyAlgorithms,
  readKnownHostKeyTypes,
  verifyHostKey,
  type KnownHostsFiles,
  type SSHHostKeyFailure,
} from "@zcode/server/remote/sshAuth.js";
import {
  createSSHUploadProgressReporter,
  formatSSHUploadError,
  formatSSHUploadLabel,
  readLocalFileSize,
} from "@zcode/server/remote/sshUploadProgress.js";

export interface SSHBackendOptions {
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  privateKey?: string | Buffer;
  privateKeyPassphrase?: string;
  password?: string;
  agent?: string;
  /** known_hosts files used for host key verification; defaults to the user's OpenSSH files. */
  knownHosts?: KnownHostsFiles;
}

type SSHUploadFailureKind = "sftp-session" | "sftp-write" | "local-read" | "aborted";

type SSHUploadFailure = Error & {
  uploadFailureKind?: SSHUploadFailureKind;
};

function normalizeUnknownError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error(fallbackMessage);
}

function markSSHUploadFailure(
  error: unknown,
  kind: SSHUploadFailureKind,
  fallbackMessage: string,
): SSHUploadFailure {
  const normalizedError = normalizeUnknownError(error, fallbackMessage) as SSHUploadFailure;
  normalizedError.uploadFailureKind = kind;
  return normalizedError;
}

function shouldLogSSHDebugMessage(message: string): boolean {
  return !/\bCHANNEL_(?:DATA|EXTENDED_DATA|WINDOW_ADJUST)\b/u.test(message);
}

function createUploadAbortError(): Error {
  const error = new Error("Remote upload canceled");
  error.name = "AbortError";
  return error;
}

function throwIfUploadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createUploadAbortError();
}

export class SSHBackend implements IRemoteBackend {
  private client: SSHClient;
  private connected = false;
  private readonly config: ConnectConfig;
  private homeDirPromise: Promise<string> | null = null;
  private execUploadOnly = false;
  private disposed = false;
  private hasEverConnected = false;
  private disconnectReported = false;
  // Set by the keyboard-interactive responder when the server asks a second-factor prompt. It is reset before every
  // connect attempt so one attempt's prompt cannot change the classification of a later, unrelated failure.
  private additionalVerificationPrompted = false;
  // Set by the host key verifier when it refuses the server key; reset before every connect attempt like the flag above.
  private hostKeyFailure: SSHHostKeyFailure | undefined;
  // Failure exit for the in-flight connect attempt; dispose uses it to end a waiting ensureConnected immediately.
  private failPendingConnect: ((error: Error) => void) | undefined;
  private readonly knownHosts: KnownHostsFiles;
  private readonly disconnectEmitter = new Emitter<RemoteDisconnectEvent>();
  readonly onDidDisconnect = this.disconnectEmitter.event;

  private readonly onClientError = (error: unknown): void => {
    if (this.disposed) {
      // When ssh2 destroys a socket after a ready timeout, it may emit another error during close/end.
      // Keep the listener during dispose only to absorb these late events; do not report them to upper
      // layers again or trigger an uncaught exception.
      return;
    }
    // Read connected first: reportDisconnect clears it, and a client-timeout after ready only comes from keepalive.
    const normalizedError = normalizeSSHConnectError(error, {
      established: this.connected,
      additionalVerificationPrompted: this.additionalVerificationPrompted,
      hostKeyFailure: this.hostKeyFailure,
    });
    // ssh2 may emit an "error" event if the underlying connection becomes unstable after ready. Without
    // a persistent listener, Node treats it as an uncaught exception and may crash the host process.
    // Record the error details before reporting disconnection; upper layers exit the host after receiving
    // the disconnect, which would otherwise lose the original error message.
    console.error("[ssh] client error:", normalizedError);
    this.reportDisconnect("error", normalizedError);
  };

  private readonly onClientClose = (): void => {
    this.reportDisconnect("close");
  };

  private readonly onClientEnd = (): void => {
    this.reportDisconnect("end");
  };

  constructor(options: SSHBackendOptions) {
    this.client = new SSHClient();
    this.client.on("error", this.onClientError);
    this.client.on("close", this.onClientClose);
    this.client.on("end", this.onClientEnd);
    this.config = buildSSHConnectConfig({
      host: options.host,
      port: options.port,
      username: options.username,
      privateKey: options.privateKey,
      passphrase: options.privateKeyPassphrase,
      password: options.password,
      agent: options.agent,
    });
    this.knownHosts = options.knownHosts ?? defaultKnownHostsFiles();
    // Without a verifier ssh2 accepts any host key (ISSUE-055). Every handshake, including automatic reconnects of this
    // cached backend, re-reads known_hosts so an edit or a trust decision takes effect without a restart.
    this.config.hostVerifier = (key: Buffer, verify: (valid: boolean) => void) => {
      void this.verifyServerHostKey(key).then(verify, () => verify(false));
    };
    if (resolveZCodeRuntimeEnv(process.env) === "development") {
      this.config.debug = (message: string) => {
        // A generic client-timeout on SSH ready does not reveal whether the stall is in TCP, negotiation,
        // or authentication. Log ssh2 handshake details only in development. CHANNEL_DATA and
        // EXTENDED_DATA are command stdout/stderr packets that arrive for every download chunk; filter
        // them to keep low-level transport events from flooding the connection panel and Electron logs.
        if (!shouldLogSSHDebugMessage(message)) {
          return;
        }
        console.debug(`[ssh2] ${message}`);
      };
    }
    if (typeof options.password === "string" && options.password.length > 0) {
      // ssh2's type definitions omit the keyboard-interactive event, though it is supported at runtime.
      // Cast locally to the EventEmitter interface instead of weakening the whole section to any for one event.
      (
        this.client as unknown as {
          on(event: string, listener: (...args: unknown[]) => void): void;
        }
      ).on(
        "keyboard-interactive",
        createKeyboardInteractiveResponder(options.password, () => {
          this.additionalVerificationPrompted = true;
        }) as unknown as (...args: unknown[]) => void,
      );
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("SSH backend 已释放，无法重新建立连接");
    }
  }

  private async verifyServerHostKey(blob: Buffer): Promise<boolean> {
    const host = this.config.host ?? "";
    const port = this.config.port ?? 22;
    const { key, lookup } = await verifyHostKey(this.knownHosts, host, port, blob);
    if (lookup.kind === "match") return true;
    this.hostKeyFailure = {
      kind: lookup.kind === "unknown" ? "unknown" : "changed",
      host,
      port,
      ...key,
    };
    return false;
  }

  private async prepareHostKeyAlgorithms(): Promise<void> {
    const knownKeyTypes = await readKnownHostKeyTypes(
      this.knownHosts,
      this.config.host ?? "",
      this.config.port ?? 22,
    );
    const serverHostKey = orderServerHostKeyAlgorithms(knownKeyTypes);
    if (serverHostKey) {
      this.config.algorithms = { ...this.config.algorithms, serverHostKey };
    } else if (this.config.algorithms?.serverHostKey) {
      const { serverHostKey: _previous, ...rest } = this.config.algorithms;
      this.config.algorithms = rest;
    }
  }

  private async ensureConnected(): Promise<void> {
    // Connection cancellation releases the backend first, but a late deploy/cleanup continuation may
    // still call ensureConnected. ssh2 Client allows connect after end, so block old credentials from
    // being revived at the backend boundary.
    this.assertNotDisposed();
    if (this.connected) return;
    await this.prepareHostKeyAlgorithms();
    this.assertNotDisposed();
    if (this.connected) return;
    return new Promise((resolve, reject) => {
      const settle = () => {
        this.client.off("ready", handleReady);
        this.client.off("error", handleConnectError);
        this.failPendingConnect = undefined;
      };
      const handleReady = () => {
        settle();
        this.connected = true;
        this.hasEverConnected = true;
        this.disconnectReported = false;
        resolve();
      };
      const handleConnectError = (error: unknown) => {
        settle();
        reject(
          normalizeSSHConnectError(error, {
            additionalVerificationPrompted: this.additionalVerificationPrompted,
            hostKeyFailure: this.hostKeyFailure,
          }),
        );
      };
      // After ssh2 receives the server banner, a dispose that closes the connection before authentication
      // completes emits neither ready nor error and clears the 60s readyTimeout; the promise below would
      // never settle, leaving the device stuck on "connecting" while every later manual connect joins the
      // same dead attempt. dispose therefore fails the in-flight attempt through this exit immediately. A
      // close event cannot be used instead: when the same ssh2 Client reconnects, the old connection's
      // close may arrive late and cannot be told apart from this attempt.
      this.failPendingConnect = (error) => {
        settle();
        reject(error);
      };
      this.client.once("ready", handleReady);
      this.client.once("error", handleConnectError);
      this.additionalVerificationPrompted = false;
      this.hostKeyFailure = undefined;
      this.client.connect(this.config);
    });
  }

  private reportDisconnect(reason: RemoteDisconnectReason, error?: Error): void {
    const shouldReport =
      !this.disposed && !this.disconnectReported && (this.connected || this.hasEverConnected);

    this.connected = false;
    this.homeDirPromise = null;

    if (!shouldReport) {
      return;
    }

    this.disconnectReported = true;
    this.disconnectEmitter.fire(error ? { reason, error } : { reason });
  }

  async detect(): Promise<RemoteEnvironment> {
    await this.ensureConnected();
    // Cause: a cold start used to open three SSH exec channels in series for platform, arch and kernel ostype,
    // and environment probing alone consumed most of the 10-second recovery budget. Keeping one POSIX channel also avoids the first-use multi-channel race.
    const output = await this.execSimple(
      "printf 'platform='; uname -s; printf 'arch='; uname -m; printf 'kernel='; " +
        "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; else printf '\\n'; fi",
    );
    const readField = (name: string): string =>
      output
        .split(/\r?\n/u)
        .find((line) => line.startsWith(`${name}=`))
        ?.slice(name.length + 1)
        .trim() ?? "";
    const reportedPlatform = normalizeRemotePlatform(readField("platform"));
    const arch = normalizeRemoteArch(readField("arch"));
    const kernelOstype = readField("kernel");
    const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

    if (platform !== reportedPlatform) {
      console.warn(
        `[ssh] detect: uname reported ${reportedPlatform}, but kernel ostype is ${kernelOstype}; fallback to ${platform}`,
      );
    }

    return { platform, arch };
  }

  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    throwIfUploadAborted(options?.signal);
    await this.ensureConnected();
    this.assertNotDisposed();
    const resolved = await this.resolveRemotePath(remotePath);
    throwIfUploadAborted(options?.signal);
    this.assertNotDisposed();
    const uploadLabel = formatSSHUploadLabel(resolved);
    console.log(`[ssh] upload: resolved ${uploadLabel} to ${resolved}`);
    const dir = posix.dirname(resolved);
    await this.execSimple(`mkdir -p ${quotePosixShellArg(dir)}`);

    if (this.execUploadOnly) {
      // exec-only caches only the transport capability; do not drop the cancellation signal and progress
      // callback that belong to each upload. Otherwise later assets after the first SFTP fallback would
      // escape connection cancellation and stop updating UI progress.
      await this.uploadViaExec(localPath, resolved, options);
      return;
    }

    try {
      await this.uploadViaSftp(localPath, resolved, options);
    } catch (error) {
      if (!this.shouldFallbackToExecUpload(error)) {
        throw error;
      }

      // Some SSH gateways/jump hosts expose different filesystem views to exec and SFTP. In these cases,
      // the earlier `mkdir -p` proves the shell view is writable, but SFTP writes to the same path still
      // return NO_SUCH_FILE. Fall back to `cat > file` to reuse the verified shell channel instead of
      // misclassifying "gateway does not support direct SFTP writes" as a connection failure. Retrying
      // SFTP on this backend would repeat the failure and flood logs, so remember exec-only after the
      // first capability failure. A new connection gets a new backend and probes SFTP again.
      this.execUploadOnly = true;
      console.warn(
        `[ssh] upload: switching ${uploadLabel} from sftp to exec pipe after ${this.describeUploadFailure(error)}`,
      );
      await this.uploadViaExec(localPath, resolved, options);
    }
  }

  async exec(command: string): Promise<StdioStream> {
    await this.ensureConnected();
    // Cancellation can occur after ensureConnected resolves and before the channel is created, so check
    // the barrier again.
    this.assertNotDisposed();
    return new Promise((resolve, reject) => {
      // SSH exec first uses the remote user's default shell; fish treats POSIX syntax such as `download=`
      // in deployment scripts as an error. Enter /bin/sh at the SSH boundary so remote deploy, preflight,
      // and server startup scripts all use the POSIX shell semantics declared by the project.
      this.client.exec(buildPosixShellExecCommand(command), (err, channel) => {
        if (err) return reject(err);

        const onClose = createCloseEventController();
        let fired = false;
        const fireOnce = (code: number) => {
          if (fired) return;
          fired = true;
          // Remote deployment runs many short commands. Logging successful code=0 exits adds no
          // diagnostic value and floods the logs. Keep only failure exit codes here; upper layers report
          // normal progress through stage and progress logs.
          if (code !== 0) {
            console.warn(`[ssh] exec channel failed: code=${code}`);
          }
          onClose.fire(code);
        };

        // ssh2 channels may fire 'exit' before 'close', or sometimes
        // only one of them. Listen to both to be safe.
        // ssh2 passes a null code when the exit came from a signal, and close carries no arguments when no exit status arrived.
        // Neither case is a success; see resolveRemoteExitCode.
        channel.on("exit", (code: number | null, signal?: string) => {
          fireOnce(resolveRemoteExitCode(code, signal));
        });
        channel.on("close", (code?: number | null, signal?: string) => {
          fireOnce(resolveRemoteExitCode(code, signal));
        });

        resolve({
          stdin: channel.stdin,
          stdout: channel,
          stderr: channel.stderr,
          onClose: onClose.event,
        });
      });
    });
  }

  async openDirectTcpChannel(port: number): Promise<Duplex> {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid remote TCP port: ${port}`);
    }
    await this.ensureConnected();
    return await new Promise<Duplex>((resolve, reject) => {
      this.client.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, channel) => {
        if (error) reject(error);
        else resolve(channel);
      });
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      const resolvedRemotePath = await this.resolveRemotePath(remotePath);
      const result = await this.execSimple(
        `test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`,
      );
      return result.trim() === "OK";
    } catch {
      return false;
    }
  }

  async readFile(remotePath: string): Promise<string> {
    const resolvedRemotePath = await this.resolveRemotePath(remotePath);
    return this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`);
  }

  /** Execute a simple command and return stdout as string */
  private execSimple(command: string): Promise<string> {
    this.assertNotDisposed();
    return new Promise((resolve, reject) => {
      // execSimple also runs POSIX fragments (such as `[ -r ... ]` and variable expansion). Use the same
      // shell policy as exec so detect/exists/readFile do not fail under fish before deployment starts.
      this.client.exec(buildPosixShellExecCommand(command), (err, channel) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        let done = false;
        let exitCode: number | null = null;

        channel.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        const finish = (code: number) => {
          if (done) return;
          done = true;
          if (code !== 0) {
            reject(new Error(`Command failed (code ${code}): ${stderr || stdout}`));
          } else {
            resolve(stdout);
          }
        };

        // For short commands, ssh2 may emit exit before asynchronously dispatching stdout data. Do not
        // finish in the exit handler or later data may be lost, occasionally leaving platform/arch
        // detection empty. Finish only on close, preferring the actual exit code recorded by exit to
        // avoid misclassifying the command as successful.
        channel.on("exit", (code: number | null, signal?: string) => {
          exitCode = resolveRemoteExitCode(code, signal);
        });
        channel.on("close", (code?: number | null, signal?: string) => {
          finish(exitCode ?? resolveRemoteExitCode(code, signal));
        });
      });
    });
  }

  private async resolveHomeDir(): Promise<string> {
    if (this.homeDirPromise) {
      return this.homeDirPromise;
    }

    this.homeDirPromise = this.execSimple('printf %s "$HOME"').then((homeDir) => homeDir.trim());
    return this.homeDirPromise;
  }

  private shouldFallbackToExecUpload(error: unknown): boolean {
    const uploadFailureKind = (error as SSHUploadFailure | undefined)?.uploadFailureKind;
    return uploadFailureKind === "sftp-session" || uploadFailureKind === "sftp-write";
  }

  private describeUploadFailure(error: unknown): string {
    const uploadFailureKind = (error as SSHUploadFailure | undefined)?.uploadFailureKind;
    const errorLabel = formatSSHUploadError(error);
    return uploadFailureKind ? `${uploadFailureKind} failure (${errorLabel})` : errorLabel;
  }

  private async uploadViaSftp(
    localPath: string,
    resolvedRemotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    throwIfUploadAborted(options?.signal);
    this.assertNotDisposed();
    const uploadLabel = formatSSHUploadLabel(resolvedRemotePath);
    const totalBytes = await readLocalFileSize(localPath);
    const progressReporter = createSSHUploadProgressReporter("sftp", uploadLabel, totalBytes);
    const reportProgress = (uploadedBytes: number, force: boolean) => {
      progressReporter(uploadedBytes, force);
      options?.onProgress?.({ uploadedBytes, totalBytes: totalBytes ?? 0 });
    };

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          // upload() handles session/write failures by falling back and recording one warning. Logging
          // an error here first would emit both error and warning for the same recoverable event, making
          // it look like deployment failed.
          reject(markSSHUploadFailure(err, "sftp-session", "Failed to open SFTP session"));
          return;
        }
        console.log(
          `[ssh] upload: started via sftp for ${uploadLabel} (${localPath} -> ${resolvedRemotePath})`,
        );

        const readStream = createReadStream(localPath);
        const writeStream = sftp.createWriteStream(resolvedRemotePath);
        let transferredBytes = 0;
        let settled = false;
        let suppressFollowupStreamErrors = false;

        const resolveOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          options?.signal?.removeEventListener("abort", abortOnce);
          reportProgress(transferredBytes, true);
          console.log(`[ssh] upload: completed via sftp for ${uploadLabel}`);
          sftp.end();
          resolve();
        };

        const rejectOnce = (error: unknown, kind: SSHUploadFailureKind, message: string) => {
          if (settled) {
            return;
          }
          settled = true;
          options?.signal?.removeEventListener("abort", abortOnce);
          suppressFollowupStreamErrors = true;
          // If the local read stream is not stopped immediately after SFTP fails, it keeps reading to
          // 100%, and the UI shows fake `[sftp] upload progress` after switching to the exec pipe. Stop
          // both streams on failure so progress logs for the first upload method stop immediately. Do
          // not pass the original error to destroy again, or cleanup will emit another duplicate error.
          readStream.unpipe(writeStream);
          readStream.destroy();
          const destroyableWriteStream = writeStream as NodeJS.WritableStream & {
            destroy?: (error?: Error) => void;
          };
          if (typeof destroyableWriteStream.destroy === "function") {
            destroyableWriteStream.destroy();
          }
          sftp.end();
          reject(markSSHUploadFailure(error, kind, message));
        };

        const abortOnce = () => {
          rejectOnce(createUploadAbortError(), "aborted", "Remote upload canceled");
        };
        if (options?.signal?.aborted) {
          abortOnce();
          return;
        }
        options?.signal?.addEventListener("abort", abortOnce, { once: true });

        readStream.on("data", (chunk: Buffer) => {
          if (settled) {
            return;
          }
          transferredBytes += chunk.length;
          reportProgress(transferredBytes, false);
        });
        writeStream.on("close", resolveOnce);
        writeStream.on("error", (error: Error) => {
          if (settled || suppressFollowupStreamErrors) {
            return;
          }
          rejectOnce(error, "sftp-write", `Failed to write ${resolvedRemotePath} over SFTP`);
        });
        readStream.on("error", (error: Error) => {
          if (settled || suppressFollowupStreamErrors) {
            return;
          }
          console.error(
            `[ssh] upload: local read failed for ${uploadLabel}: ${formatSSHUploadError(error)}`,
          );
          rejectOnce(error, "local-read", `Failed to read local file ${localPath}`);
        });
        readStream.pipe(writeStream);
      });
    });
  }

  private async uploadViaExec(
    localPath: string,
    resolvedRemotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    const uploadLabel = formatSSHUploadLabel(resolvedRemotePath);
    const totalBytes = await readLocalFileSize(localPath);
    const progressReporter = createSSHUploadProgressReporter("exec", uploadLabel, totalBytes);
    const reportProgress = (uploadedBytes: number, force: boolean) => {
      progressReporter(uploadedBytes, force);
      options?.onProgress?.({ uploadedBytes, totalBytes: totalBytes ?? 0 });
    };
    throwIfUploadAborted(options?.signal);
    const parentDir = posix.dirname(resolvedRemotePath);
    const command = `mkdir -p ${quotePosixShellArg(parentDir)} && cat > ${quotePosixShellArg(resolvedRemotePath)}`;
    console.log(
      `[ssh] upload: started via exec pipe for ${uploadLabel} (${localPath} -> ${resolvedRemotePath})`,
    );
    const stream = await this.exec(command);

    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let transferredBytes = 0;
      let settled = false;

      const finishWithError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        options?.signal?.removeEventListener("abort", abortOnce);
        readStream.destroy();
        const destroyableStdin = stdin as NodeJS.WritableStream & {
          destroy?: (reason?: Error) => void;
        };
        if (typeof destroyableStdin.destroy === "function") {
          destroyableStdin.destroy(error);
        } else {
          stdin.end();
        }
        reject(error);
      };

      const abortOnce = () => finishWithError(createUploadAbortError());
      if (options?.signal?.aborted) {
        abortOnce();
        return;
      }
      options?.signal?.addEventListener("abort", abortOnce, { once: true });

      readStream.on("error", (error) => finishWithError(error));
      readStream.on("data", (chunk: Buffer) => {
        transferredBytes += chunk.length;
        reportProgress(transferredBytes, false);
      });
      stdin.on("error", (error: Error) => finishWithError(error));
      readStream.pipe(stdin);
      stream.onClose((code) => {
        if (settled) {
          return;
        }
        settled = true;
        options?.signal?.removeEventListener("abort", abortOnce);
        reportProgress(transferredBytes, true);
        if (code !== 0) {
          console.error(`[ssh] upload: exec pipe failed for ${uploadLabel}: exit code ${code}`);
          reject(new Error(`SSH exec upload failed with exit code ${code}`));
          return;
        }
        console.log(`[ssh] upload: completed via exec pipe for ${uploadLabel}`);
        resolve();
      });
    });
  }

  private async resolveRemotePath(remotePath: string): Promise<string> {
    const homeDir = await this.resolveHomeDir();
    return resolvePosixHomePath(remotePath, homeDir);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // Fail the in-flight connect first and remove its ready listener: a late ready can no longer mark
    // the cancelled connection's old credentials as connected, and the caller does not have to wait for
    // the socket to close (which may sit on the OS connect timeout when TCP was never established).
    this.failPendingConnect?.(new Error("SSH backend 已释放，无法重新建立连接"));
    // After an initial handshake failure, ssh2 may emit error after the socket's end/close events.
    // Keep onClientError as a no-op sink after dispose; removing it based on end/close ordering could let
    // a late event escape as an uncaughtException and take down other workspaces in the shared Window
    // Host. This backend is the only owner of the client, so the listener is reclaimed with it; first
    // ensure the retired backend cannot crash the process.
    this.client.off("close", this.onClientClose);
    this.client.off("end", this.onClientEnd);
    this.client.end();
    this.connected = false;
    this.disconnectEmitter.dispose();
  }
}
