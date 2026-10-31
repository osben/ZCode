/* eslint-disable max-lines -- Source Server transport converges install, daemon, channel, and target lifecycles in one adapter; splitting it further would fracture cancellation boundaries. */
import { Duplex } from "node:stream";
import {
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  normalizeRemoteAssetInstallMode,
  sourceServerInstallProgressSchema,
  type SourceServerInstallProgress,
  type PublicZCodeErrorCode,
  type RemoteTarget,
} from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { createRemoteBackend } from "@zcode/server/remote/create-backend.js";
import { detectRemoteTarTool } from "@zcode/server/remote/remoteAssetPreflight.js";
import {
  probeSourceServer,
  SourceServerProbeEnvironmentError,
} from "@zcode/server/source-server/sourceServerProbe.js";
import { buildSourceServerReleaseDownloadCommand } from "@zcode/server/source-server/sourceServerReleaseDownload.js";
import {
  collectCommand,
  duplexFromStdio,
  quoteShellArg,
  readLastJsonLine,
  readStructuredCommandCode,
  readStructuredCommandError,
  throwIfAborted,
  type RemoteExecResult,
} from "@zcode/server/source-server/sourceServerTransportRuntime.js";

export type { RemoteExecResult } from "@zcode/server/source-server/sourceServerTransportRuntime.js";

export interface SourceServerProbeResult {
  platform: string;
  arch: string;
  installed: boolean;
  installPath?: string;
  installedVersion?: string;
  installedArchiveSha256?: string;
  /** Version replaced when the current release was installed by an explicit downgrade. */
  downgradedFrom?: string;
  daemonStatus?: Record<string, unknown> & { state: string; port?: number };
}

export interface SourceServerProbeOptions {
  includeReleaseIdentity?: boolean;
}

export interface SourceServerIngressInfo {
  port: number;
  ingressToken: string;
  /** Port taken from the status.json snapshot read by the probe; serve --daemon was not run. */
  reusedProbeStatus?: true;
}

export interface ServerReleaseAsset {
  localArchivePath?: string;
  target: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  urls: string[];
}

export interface TransportContext {
  signal?: AbortSignal;
  onLog?: (event: {
    phase: string;
    message: string;
    progress?: number;
    level?: "info" | "warn" | "error";
  }) => void;
}

export interface SourceServerInstallOrUpdateOptions {
  force?: boolean;
  /** The user confirmed switching the remote to an older version; the remote CLI decides the
   *  direction from the real current value. */
  allowDowngrade?: boolean;
}

export interface SourceServerEnsureDaemonOptions {
  observedStatus?: SourceServerProbeResult["daemonStatus"];
}

export class SourceServerTransportOperationError extends Error {
  public constructor(
    message: string,
    public readonly code: PublicZCodeErrorCode,
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "SourceServerTransportOperationError";
  }
}

/**
 * A failing remote Server CLI `--json` command outputs `{ok:false,error,code?,retryable?}`
 * (written to stdout). Public error codes must be preserved verbatim for Host/UI
 * classification; taking only the error text is not enough.
 */
function createServerCommandError(result: RemoteExecResult, fallbackMessage: string): Error {
  try {
    const response = readLastJsonLine(result.stdout);
    if (isPublicZCodeErrorCode(response.code)) {
      return new SourceServerTransportOperationError(
        typeof response.error === "string" && response.error.trim()
          ? response.error
          : fallbackMessage,
        response.code,
        typeof response.retryable === "boolean" ? response.retryable : undefined,
      );
    }
  } catch {
    // Non-JSON output falls through to text diagnostics.
  }
  // Bug cause: the CLI writes --json errors to stdout and stderr may hold only a SQLite
  // warning; the install path and daemon startup share this error parsing so a warning cannot
  // mask the real failure reason.
  return new Error(
    (readStructuredCommandError(result.stdout) ?? result.stderr.trim()) || fallbackMessage,
  );
}

/** Read the final JSON of a remote Server CLI `--json` command; a nonzero exit fails via
 *  {@link createServerCommandError}. */
export function readServerCommandResult(
  result: RemoteExecResult,
  fallbackMessage: string,
): Record<string, unknown> {
  if (result.exitCode !== 0) throw createServerCommandError(result, fallbackMessage);
  return readLastJsonLine(result.stdout);
}

export type SourceServerFileTransfer = Pick<IRemoteBackend, "exec" | "upload">;

export interface SourceServerTransportAdapter {
  readonly kind: "ssh" | "wsl" | "docker";
  /** Host attachment staging reuses the current target's transport; no second remote
   *  connection is created. */
  createFileTransfer(target: RemoteTarget): SourceServerFileTransfer;
  /** Cancel the underlying transport of a single connection target so a timed-out flight cannot
   *  arrive late and register as an online Source. */
  cancel?(target: RemoteTarget): void;
  probe(
    target: RemoteTarget,
    context: TransportContext,
    options?: SourceServerProbeOptions,
  ): Promise<SourceServerProbeResult>;
  installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options?: SourceServerInstallOrUpdateOptions,
  ): Promise<void>;
  ensureDaemon(
    target: RemoteTarget,
    context: TransportContext,
    options?: SourceServerEnsureDaemonOptions,
  ): Promise<SourceServerIngressInfo>;
  openChannel(
    target: RemoteTarget,
    ingress: SourceServerIngressInfo,
    context: TransportContext,
  ): Promise<Duplex>;
  exec(target: RemoteTarget, argv: string[], context: TransportContext): Promise<RemoteExecResult>;
  dispose?(): void;
}

export interface CreateSourceServerTransportAdapterOptions {
  createBackend?: (target: RemoteTarget) => Promise<IRemoteBackend>;
}

const SERVER_ROOT_READ_PATH = "~/.zcode/server";
const SERVER_ROOT_SHELL = '"$HOME/.zcode/server"';
const SERVER_BIN_SHELL = '"$HOME/.zcode/server/bin/zcode"';
const STALE_BOOTSTRAP_AGE_MS = 30 * 60 * 1_000;
const INSTALL_PROGRESS_MESSAGES: Record<SourceServerInstallProgress["phase"], string> = {
  "verify-archive": "Verifying Source Server archive",
  extract: "Extracting Source Server files",
  verify: "Verifying Source Server files",
  restart: "Restarting Source Server",
};

type DirectChannelBackend = IRemoteBackend & {
  openDirectTcpChannel?: (port: number) => Promise<Duplex>;
};

class BackendSourceServerTransportAdapter implements SourceServerTransportAdapter {
  private readonly backends = new WeakMap<object, Promise<IRemoteBackend>>();
  private readonly backendPromises = new Set<Promise<IRemoteBackend>>();

  public constructor(
    public readonly kind: "ssh" | "wsl" | "docker",
    private readonly createBackend: (target: RemoteTarget) => Promise<IRemoteBackend>,
  ) {}

  public createFileTransfer(target: RemoteTarget): SourceServerFileTransfer {
    // R3 full-forwarding missed the cross-machine boundary of desktop localPath; only reuse the
    // existing backend's file primitives.
    const backend = this.getBackend(target);
    return {
      exec: async (command) => (await backend).exec(command),
      upload: async (localPath, remotePath, options) =>
        (await backend).upload(localPath, remotePath, options),
    };
  }

  public async probe(
    target: RemoteTarget,
    context: TransportContext,
    options: SourceServerProbeOptions = {},
  ): Promise<SourceServerProbeResult> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    try {
      return await probeSourceServer(backend, context, options);
    } catch (error) {
      // Bug cause: the catch wrapped every failure in the preflight stage fallback, so
      // unrecognized transport failures (handshake timeout, disconnect before handshake) were
      // reported as "device environment does not meet install requirements", and the banner
      // reused that misreport when reconnect exhausted its budget. Only a failure of the remote
      // environment check itself is a preflight failure; unidentifiable transport failures are
      // classified as unknown.
      const failure = normalizeRemoteConnectionError(
        error,
        error instanceof SourceServerProbeEnvironmentError ? "preflight" : undefined,
      );
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
    }
  }

  public async installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options: SourceServerInstallOrUpdateOptions = {},
  ): Promise<void> {
    let phase = "preflight";
    try {
      await this.installRelease(
        target,
        release,
        {
          ...context,
          onLog: (event) => {
            phase = event.phase;
            context.onLog?.(event);
          },
        },
        options,
      );
    } catch (error) {
      const failure = normalizeRemoteConnectionError(error, phase);
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
    }
  }

  private async installRelease(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options: SourceServerInstallOrUpdateOptions,
  ): Promise<void> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    const operationId = `${process.pid}-${Date.now()}`;
    const bootstrapRootShell = `${SERVER_ROOT_SHELL}/.bootstrap-${operationId}`;
    const bootstrapDirShell = `${bootstrapRootShell}/extract`;
    const remoteArchive = `~/.zcode/server/.bootstrap-${operationId}/zcode-server.tar.gz`;
    const remoteArchiveShell = `${bootstrapRootShell}/zcode-server.tar.gz`;
    const cleanupCommand = `rm -rf ${bootstrapRootShell}`;
    const cleanupStaleBootstrapRootsCommand =
      "now_ms=$(($(date +%s) * 1000)); " +
      `for candidate in ${SERVER_ROOT_SHELL}/.bootstrap-*; do ` +
      '[ -d "$candidate" ] || continue; ' +
      "name=${candidate##*/}; " +
      "created_ms=${name##*-}; " +
      'case "$created_ms" in ""|*[!0-9]*) continue ;; esac; ' +
      "age_ms=$((now_ms - created_ms)); " +
      `[ "$age_ms" -le ${STALE_BOOTSTRAP_AGE_MS} ] || rm -rf -- "$candidate"; ` +
      "done";
    const prepareBootstrapRoot = async (): Promise<void> => {
      const result = await collectCommand(
        await backend.exec(
          // Bug cause: when the Controller is force-quit during SFTP/upload, neither the JS
          // catch nor the remote EXIT trap gets to run, and Server root permanently accumulates
          // tens of MiB of partial packages. The next install reclaims only private staging
          // with a legal epoch suffix older than 30 minutes; fresh concurrent operations and
          // unknown directories are always kept.
          `${cleanupStaleBootstrapRootsCommand} && rm -rf ${bootstrapRootShell} && mkdir -p ${bootstrapRootShell}`,
        ),
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || "Source Server bootstrap staging failed");
      }
    };
    // Bug cause: after R3 switched to the full archive, installs went through Desktop upload
    // unconditionally and the remote-download option saved in the SSH form became dead. Only
    // the archive fetch location is branched here; both paths converge on the same installer.
    const remoteDownload =
      target.kind === "ssh" &&
      normalizeRemoteAssetInstallMode(target.assetInstallMode) === "remote-download" &&
      // Bug cause: the dev-mode resolver has already pinned this round's local archive; if the
      // Profile preference still forced a direct download, the bootstrap artifact would be
      // replaced by the CDN release of the same version. An explicit local path wins artifact
      // source priority.
      !release.localArchivePath;
    if (remoteDownload) {
      context.onLog?.({
        phase: "download",
        message: `Downloading Source Server ${release.version} on remote host`,
      });
      const downloadCommand = await buildSourceServerReleaseDownloadCommand({
        backend,
        release,
        remoteArchive,
        onLog: (message) => context.onLog?.({ phase: "download", message }),
      });
      await prepareBootstrapRoot();
      const downloadResult = await collectCommand(await backend.exec(downloadCommand), (line) => {
        if (/^download progress:/iu.test(line.trim()))
          context.onLog?.({ phase: "download", message: line.trim() });
      });
      if (downloadResult.exitCode !== 0) {
        await collectCommand(await backend.exec(cleanupCommand)).catch(() => undefined);
        throw new Error(
          downloadResult.stderr.trim() || "Remote Source Server archive download failed",
        );
      }
    } else {
      if (!release.localArchivePath) {
        throw new Error("Source Server local archive is unavailable for upload");
      }
      // Bug cause: the local download-upload path used to skip the tar preflight, uploading the
      // full archive only to fail at remote extraction; the old hint also wrongly suggested
      // switching back to local upload, which needs tar just as much.
      context.onLog?.({
        phase: "preflight",
        message: "Checking remote installation prerequisites",
      });
      await detectRemoteTarTool(backend, {
        log: (message) => context.onLog?.({ phase: "preflight", message: String(message) }),
      });
      await prepareBootstrapRoot();
      context.onLog?.({
        phase: "upload",
        message: `Uploading Source Server ${release.version}`,
      });
      const uploadStartedAt = Date.now();
      try {
        await backend.upload(release.localArchivePath, remoteArchive, {
          signal: context.signal,
          onProgress: ({ uploadedBytes, totalBytes }) =>
            context.onLog?.({
              phase: "upload",
              message: `upload progress: ${(totalBytes > 0 ? (uploadedBytes / totalBytes) * 100 : 0).toFixed(1)}% (${(uploadedBytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB, ${(uploadedBytes / 1048576 / Math.max(0.001, (Date.now() - uploadStartedAt) / 1000)).toFixed(2)} MB/s)`,
              progress: totalBytes > 0 ? uploadedBytes / totalBytes : 0,
            }),
        });
      } catch (error) {
        await collectCommand(await backend.exec(cleanupCommand)).catch(() => undefined);
        throw error;
      }
    }
    context.onLog?.({ phase: "extract", message: INSTALL_PROGRESS_MESSAGES.extract });
    const command = [
      "set -eu",
      // Bug cause: after the running-task guard made update exit nonzero, `&& rm` never ran
      // and the remote archive plus bootstrap staging kept accumulating. The EXIT trap covers
      // success, the guard, extraction failure, and interruption.
      `trap ${quoteShellArg(cleanupCommand)} EXIT`,
      // Bug cause: hardened/minimal servers often mount /tmp noexec or as a tiny tmpfs.
      // Although extraction had moved to Server root, the 75MB archive was still written to
      // /tmp first, and with insufficient space the upload hit EPIPE at 90%. The archive and
      // the executable bootstrap must sit in the same private Server staging root.
      `rm -rf ${bootstrapDirShell}`,
      `mkdir -p ${bootstrapDirShell}`,
      `tar -xzf ${remoteArchiveShell} -C ${bootstrapDirShell} --strip-components=1`,
      // Bug cause: update now restarts the full daemon; if the existing transport capability
      // boundary is not passed to the target bootstrap CLI, WSL/Docker will try to register an
      // unavailable systemd user service at handoff.
      `${this.kind === "ssh" ? "" : "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "}${bootstrapDirShell}/bin/zcode update --from-archive ${remoteArchiveShell}${options.force ? " --force" : ""}${options.allowDowngrade ? " --allow-downgrade" : ""} --server-root ${SERVER_ROOT_SHELL} --json --progress`,
    ].join(" && ");
    // After upload, the command still extracts, verifies the whole tree, and rotates the
    // daemon; phases must be consumed as they arrive, not displayed only at exit.
    const result = await collectCommand(await backend.exec(command), (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const event = sourceServerInstallProgressSchema.safeParse(value);
      if (event.success) {
        context.onLog?.({
          phase: event.data.phase,
          message: INSTALL_PROGRESS_MESSAGES[event.data.phase],
        });
      }
    });
    if (result.exitCode !== 0) {
      throw createServerCommandError(result, "Source Server archive installation failed");
    }
    const response = readLastJsonLine(result.stdout);
    if (response.ok === false || response.applied !== true) {
      throw new Error("Source Server archive installation did not apply the release");
    }
    context.onLog?.({
      phase: "install",
      message: `Source Server ${release.version} installed`,
    });
  }

  public async ensureDaemon(
    target: RemoteTarget,
    context: TransportContext,
    options: SourceServerEnsureDaemonOptions = {},
  ): Promise<SourceServerIngressInfo> {
    throwIfAborted(context.signal);
    let status = options.observedStatus;
    const observedReady =
      status?.state === "ready" && Number.isInteger(status.port) && (status.port as number) > 0;
    if (!observedReady) {
      context.onLog?.({ phase: "daemon", message: "Starting Source Server" });
      const result = await this.exec(target, ["serve", "--daemon", "--json"], context);
      if (result.exitCode !== 0) {
        // Bug cause: the Server CLI's --json errors are written to stdout while Node runtime
        // warnings go to stderr. The old logic read only stderr and ended up presenting a SQLite
        // warning as the root cause of the connection failure.
        const message =
          (readStructuredCommandError(result.stdout) ?? result.stderr.trim()) ||
          "Source Server daemon failed to start";
        // The CLI failure text appends the Core's failure reason; when the CLI already carried a
        // code for its original first sentence, use that code so the appended detail cannot
        // re-classify the category by text.
        const code = readStructuredCommandCode(result.stdout);
        throw code ? new SourceServerTransportOperationError(message, code) : new Error(message);
      }
      status = readLastJsonLine(result.stdout) as SourceServerProbeResult["daemonStatus"];
    }
    // Bug cause: re-running serve --daemon after the probe just confirmed ready wastes a remote
    // round-trip and pushed cold starts past the 10-second budget. A ready status only reuses
    // the port; the ingress token is still read fresh every time.
    if (!status) throw new Error("Source Server daemon status is unavailable");
    const port = status.port;
    if (!Number.isInteger(port) || (port as number) <= 0) {
      throw new Error("Source Server daemon did not report a valid ingress port");
    }
    // Bug cause: when reusing a daemon the probe already confirmed ready, the code still
    // printed "started in detached fallback mode" based on serviceRegistered, making the logs
    // read as if every connection spawned another instance. The startup mode is reported only
    // when serve --daemon actually ran this time.
    if (observedReady) {
      context.onLog?.({ phase: "daemon", message: "Reusing running Source Server" });
    } else if (status.serviceRegistered === false) {
      // Bug cause: after systemd loading fails the CLI falls back, and the reason lives only in
      // this run's serviceFallbackReason output; leaving it out of the connection log hid why
      // the OS user service was not used. Redaction is handled uniformly by the connection log.
      const fallbackReason =
        typeof status.serviceFallbackReason === "string" ? status.serviceFallbackReason.trim() : "";
      context.onLog?.({
        phase: "daemon",
        message: `Source Server started in detached fallback mode for this remote environment${fallbackReason ? ` (${fallbackReason})` : ""}`,
      });
    } else if (status.serviceRegistered === true) {
      context.onLog?.({
        phase: "daemon",
        message: "Source Server registered with the remote OS user service manager",
      });
    }
    const backend = await this.getBackend(target);
    const ingressToken = (
      await backend.readFile(`${SERVER_ROOT_READ_PATH}/run/ingress-token`)
    ).trim();
    if (!ingressToken) throw new Error("Source Server ingress token is missing");
    return {
      port: port as number,
      ingressToken,
      ...(observedReady ? { reusedProbeStatus: true } : {}),
    };
  }

  public async openChannel(
    target: RemoteTarget,
    ingress: SourceServerIngressInfo,
    context: TransportContext,
  ): Promise<Duplex> {
    throwIfAborted(context.signal);
    const backend = (await this.getBackend(target)) as DirectChannelBackend;
    if (this.kind === "ssh" && backend.openDirectTcpChannel) {
      try {
        return await backend.openDirectTcpChannel(ingress.port);
      } catch (error) {
        context.onLog?.({
          phase: "channel",
          message: `SSH direct-tcpip unavailable; using proxy-stdio (${error instanceof Error ? error.message : String(error)})`,
        });
      }
    }
    return duplexFromStdio(
      await backend.exec(
        `${SERVER_BIN_SHELL} server proxy-stdio --server-root ${SERVER_ROOT_SHELL}`,
      ),
    );
  }

  public async exec(
    target: RemoteTarget,
    argv: string[],
    context: TransportContext,
  ): Promise<RemoteExecResult> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    const hasServerRoot = argv.includes("--server-root");
    // `restart` re-runs serve --daemon on the remote and must keep detached fallback the same
    // way (R2 §8.1).
    const startsDaemon =
      (argv[0] === "serve" && argv.includes("--daemon")) || argv[0] === "restart";
    const daemonEnvironment =
      this.kind !== "ssh" && startsDaemon ? "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 " : "";
    const command = [
      // Bug cause: WSL/Docker have no stable user-level service manager; reusing the SSH
      // command would try to register a systemd user service and fail in common environments.
      // Both must explicitly enter detached fallback.
      `${daemonEnvironment}${SERVER_BIN_SHELL}`,
      ...argv.map(quoteShellArg),
      ...(hasServerRoot ? [] : ["--server-root", SERVER_ROOT_SHELL]),
    ].join(" ");
    return await collectCommand(await backend.exec(command));
  }

  public dispose(): void {
    for (const backend of this.backendPromises) {
      void backend.then(
        (resolved) => resolved.dispose(),
        () => undefined,
      );
    }
    this.backendPromises.clear();
  }

  public cancel(target: RemoteTarget): void {
    if (target.kind !== this.kind) return;
    const key = target as object;
    const backend = this.backends.get(key);
    if (!backend) return;
    // Bug cause: the 10-second startup timeout used to reject only the outer promise while the
    // SSH handshake kept going in the background and registered the Source online on arrival.
    // Remove exactly this target's backend so a later manual retry can build a new transport.
    this.backends.delete(key);
    this.backendPromises.delete(backend);
    void backend.then(
      (resolved) => resolved.dispose(),
      () => undefined,
    );
  }

  private async getBackend(target: RemoteTarget): Promise<IRemoteBackend> {
    if (target.kind !== this.kind) {
      throw new Error(`Transport ${this.kind} cannot handle target ${target.kind}`);
    }
    const key = target as object;
    let backend = this.backends.get(key);
    if (!backend) {
      backend = this.createBackend(target);
      this.backends.set(key, backend);
      this.backendPromises.add(backend);
    }
    return await backend;
  }
}

export function createSourceServerTransportAdapter(
  kind: "ssh" | "wsl" | "docker",
  options: CreateSourceServerTransportAdapterOptions = {},
): SourceServerTransportAdapter {
  return new BackendSourceServerTransportAdapter(
    kind,
    options.createBackend ?? createRemoteBackend,
  );
}
