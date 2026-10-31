import { spawn, execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { DockerConnectOptions, PublicZCodeErrorCode } from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import {
  createCloseEventController,
  resolveRemoteExitCode,
} from "@zcode/server/remote/closeEvent.js";
import {
  listDockerContainers,
  probeDockerDaemon,
  resolveDockerCommand,
  type DockerContainerInfo,
} from "@zcode/server/remote/docker-detect.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";

interface ResolvedDockerInfo {
  containerName: string;
  homeDir: string;
}

const DOCKER_EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const DOCKER_UPLOAD_MAX_STDERR_LENGTH = 2_048;

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizeDockerOutput(raw: string): string {
  return raw.replace(/\r/g, "");
}

function buildDockerExecArgs(containerName: string, commandArgs: string[]): string[] {
  // Direct exec/read skips container enumeration, which used to perform implicit validation; reject option shapes and invalid references where argv is assembled.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) {
    throw new Error("Invalid Docker container reference");
  }
  return ["exec", "-i", containerName, ...commandArgs];
}

export class DockerBackend implements IRemoteBackend {
  private readonly dockerCommand = resolveDockerCommand();
  private readonly options: DockerConnectOptions;
  private availabilityPromise: Promise<void> | null = null;
  private resolvedInfoPromise: Promise<ResolvedDockerInfo> | null = null;

  constructor(options: DockerConnectOptions) {
    this.options = options;
  }

  async detect(): Promise<RemoteEnvironment> {
    await this.ensureAvailable();
    const reportedPlatform = normalizeRemotePlatform(
      normalizeDockerOutput(await this.execSimple("uname -s")),
    );
    const arch = normalizeRemoteArch(normalizeDockerOutput(await this.execSimple("uname -m")));
    const kernelOstype = await this.readKernelOstype();
    const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

    if (platform !== reportedPlatform) {
      // Test containers may spoof uname output through a wrapper;
      // log at low frequency only when fallback occurs, to help diagnose why the Linux package was ultimately selected.
      console.warn(
        `[docker] detect: uname reported ${reportedPlatform}, but kernel ostype is ${kernelOstype}; fallback to ${platform}`,
      );
    }

    return {
      platform,
      arch,
    };
  }

  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
    const parentDir = this.dirname(resolvedRemotePath);

    // The upload stream does not create parent directories.
    // On a first connection, uploading directly to a path such as `~/.zcode/server/...` would fail because the directory does not exist.
    // Run `mkdir -p` explicitly first, then write the target file as the current container user, matching SSH/WSL behavior.
    await this.execSimple(`mkdir -p ${quotePosixShellArg(parentDir)}`);

    // A file copied into the container with `docker cp` may retain the host UID/GID,
    // preventing a non-root container user from running chmod afterward. Always write through stdin as the current container user
    // so file ownership matches the user that runs subsequent deployment commands.
    await this.uploadViaExec(localPath, resolvedRemotePath, options ?? {});
  }

  private async uploadViaExec(
    localPath: string,
    resolvedRemotePath: string,
    options: RemoteUploadOptions,
  ): Promise<void> {
    const totalBytes = await stat(localPath).then((value) => value.size);
    if (options.signal?.aborted) {
      const error = new Error("Remote upload canceled");
      error.name = "AbortError";
      throw error;
    }
    const stream = await this.exec(`cat > ${quotePosixShellArg(resolvedRemotePath)}`);
    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let stderrText = "";
      let uploadedBytes = 0;
      let settled = false;
      const onStderr = (chunk: Buffer | string) => {
        stderrText = `${stderrText}${chunk.toString()}`.slice(-DOCKER_UPLOAD_MAX_STDERR_LENGTH);
      };
      stream.stderr.on("data", onStderr);
      const removeStderrListener = () => {
        stream.stderr.removeListener("data", onStderr);
      };
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        removeStderrListener();
        readStream.destroy();
        const destroyable = stdin as NodeJS.WritableStream & {
          destroy?: (reason?: Error) => void;
        };
        destroyable.destroy?.(error);
        reject(error);
      };
      const abort = () => {
        const error = new Error("Remote upload canceled");
        error.name = "AbortError";
        finishError(error);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      readStream.on("data", (chunk: Buffer) => {
        uploadedBytes += chunk.length;
        options.onProgress?.({ uploadedBytes, totalBytes });
      });
      readStream.on("error", finishError);
      stdin.on("error", finishError);
      stream.onClose((code) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        removeStderrListener();
        if (code !== 0) {
          const stderrSummary = normalizeDockerOutput(stderrText).trim();
          reject(
            new Error(
              stderrSummary
                ? `Docker upload failed with exit code ${code}: ${stderrSummary}`
                : `Docker upload failed with exit code ${code}`,
            ),
          );
          return;
        }
        options.onProgress?.({ uploadedBytes: totalBytes, totalBytes });
        resolve();
      });
      readStream.pipe(stdin);
    });
  }

  async exec(command: string): Promise<StdioStream> {
    // Cause: `docker exec` itself accepts names, full IDs and ID prefixes, and authoritatively reports daemon/container state.
    // The old code ran `docker version` before every command, plus two `docker ps` calls and a home probe on first use, so a
    // cold-start Source's single round-trip probe was amplified into five CLI commands. Plain exec does not resolve remote paths
    // and uses the user-confirmed container ref directly; read/upload, which need `~` expanded to a local path, still go through
    // the strict resolveInfo validation.
    const containerRef = this.options.container.trim();

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.dockerCommand,
        buildDockerExecArgs(containerRef, ["sh", "-lc", command]),
        {
          stdio: "pipe",
          windowsHide: true,
        },
      );

      child.once("error", reject);
      child.once("spawn", () => {
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (!stdin || !stdout || !stderr) {
          reject(new Error("Docker exec stdio is not available"));
          return;
        }

        const onClose = createCloseEventController();
        let fired = false;
        const fireOnce = (code: number) => {
          if (fired) {
            return;
          }
          fired = true;
          onClose.fire(code);
        };

        // A signal-terminated process has a null code and must not count as success; see resolveRemoteExitCode.
        child.on("exit", (code, signal) => {
          fireOnce(resolveRemoteExitCode(code, signal));
        });
        child.on("close", (code, signal) => {
          fireOnce(resolveRemoteExitCode(code, signal));
        });

        resolve({
          stdin,
          stdout,
          stderr,
          onClose: onClose.event,
        });
      });
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      const resolvedInfo = await this.resolveInfo();
      const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
      await this.execSimple(`test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(remotePath: string): Promise<string> {
    if (remotePath === "~" || remotePath.startsWith("~/")) {
      // Internal files such as the Source ingress token are already expressed as home-relative paths; the shell expands `$HOME`
      // authoritatively inside the container, so there is no need to resolve the same container/home first with docker ps + docker exec.
      const shellPath =
        remotePath === "~" ? '"$HOME"' : `"$HOME"/${quotePosixShellArg(remotePath.slice(2))}`;
      return normalizeDockerOutput(
        await this.execDirectInContainer(this.options.container.trim(), [
          "sh",
          "-lc",
          `cat ${shellPath}`,
        ]),
      );
    }
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = this.resolveLinuxPath(remotePath, resolvedInfo.homeDir);
    return normalizeDockerOutput(
      await this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`),
    );
  }

  dispose(): void {
    // Docker backend commands are one-shot child processes; there are no persistent connections to clean up explicitly.
  }

  async diagnoseExecFailure(): Promise<void> {
    // exec skips the daemon probe up front to stay within the cold-start budget (see the exec comment), so it probes once only after a command fails.
    // Discard any earlier success: the daemon may have stopped since, and a stale cache would misclassify this failure as the command's own failure.
    this.availabilityPromise = null;
    await this.ensureAvailable();
  }

  private async ensureAvailable(): Promise<void> {
    if (!this.availabilityPromise) {
      // Cause: every Docker exec inside the Source probe re-ran `docker version`, and the first container/home resolution re-ran `docker ps`.
      // At the cold-start peak, four or five CLI round-trips could exhaust the 10-second budget of a single local Docker Source before the
      // real probe started. The daemon only needs one probe per backend lifecycle; a failure clears the promise so a later explicit retry still re-checks.
      // The daemon probe error carries the reason (for example "Cannot connect to the Docker daemon"), which is kept in the message.
      this.availabilityPromise = probeDockerDaemon().catch((error: unknown) => {
        this.availabilityPromise = null;
        const reason = error instanceof Error ? error.message.trim() : String(error).trim();
        throw Object.assign(
          new Error(
            reason
              ? `当前系统未检测到可用的 Docker 环境：${reason}`
              : "当前系统未检测到可用的 Docker 环境",
          ),
          { code: "remote-connection-unknown" satisfies PublicZCodeErrorCode },
        );
      });
    }
    await this.availabilityPromise;
  }

  private async resolveInfo(): Promise<ResolvedDockerInfo> {
    if (this.resolvedInfoPromise) {
      return this.resolvedInfoPromise;
    }

    this.resolvedInfoPromise = (async () => {
      const container = await this.resolveContainer();
      const homeDir = normalizeDockerOutput(
        await this.execDirectInContainer(container.name, ["sh", "-lc", "printf %s ~"]),
      ).trim();

      return {
        containerName: container.name,
        homeDir,
      };
    })();

    return this.resolvedInfoPromise;
  }

  private async resolveContainer(): Promise<DockerContainerInfo> {
    const containers = await listDockerContainers({ all: true });
    const matched = containers.find(
      (container) =>
        container.name === this.options.container ||
        container.id === this.options.container ||
        container.id.startsWith(this.options.container),
    );

    if (!matched) {
      throw new Error(`未找到名为 ${this.options.container} 的 Docker 容器`);
    }

    if (matched.state.toLowerCase() !== "running") {
      throw new Error(
        `Docker 容器 ${matched.name} 当前未运行（state=${matched.state || "unknown"}）`,
      );
    }

    return matched;
  }

  private resolveLinuxPath(remotePath: string, homeDir: string): string {
    if (remotePath === "~") {
      return homeDir;
    }

    if (remotePath.startsWith("~/")) {
      return `${homeDir.replace(/\/$/, "")}/${remotePath.slice(2)}`;
    }

    return remotePath;
  }

  private dirname(remotePath: string): string {
    const normalized = remotePath.replace(/\/+/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash <= 0) {
      return "/";
    }

    return normalized.slice(0, lastSlash);
  }

  private async execSimple(command: string): Promise<string> {
    return this.execDirect(["sh", "-lc", command]);
  }

  private async readKernelOstype(): Promise<string> {
    try {
      return normalizeDockerOutput(
        await this.execSimple(
          "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; fi",
        ),
      ).trim();
    } catch {
      return "";
    }
  }

  private async execDirect(commandArgs: string[]): Promise<string> {
    const container = await this.resolveContainer();
    return await this.execDirectInContainer(container.name, commandArgs);
  }

  private async execDirectInContainer(
    containerName: string,
    commandArgs: string[],
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.dockerCommand,
        buildDockerExecArgs(containerName, commandArgs),
        {
          encoding: "utf8",
          maxBuffer: DOCKER_EXEC_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(normalizeDockerOutput(stderr).trim() || error.message));
            return;
          }

          resolve(normalizeDockerOutput(stdout));
        },
      );
    });
  }
}
