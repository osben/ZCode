import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { type DeployLoggers, waitForClose } from "@zcode/server/remote/deployShared.js";
import { quotePosixPathArg } from "@zcode/server/remote/posixShell.js";

export async function repairLegacyRemoteOfficialPluginDirectoryPermissions(params: {
  backend: IRemoteBackend;
  loggers: DeployLoggers;
  remoteOfficialPluginDir: string;
}): Promise<boolean> {
  // Older versions created packages tar files on Windows with directory mode 0666, which combined with the remote umask
  // produced non-traversable 0644 directories. When upgrading from 3.3.3 to 3.3.4, complete files still need replacement because the version changed,
  // so permission repair must be tied to the deployment path that replaces packages, not the incremental skip path for a healthy remote.
  // IRemoteBackend.exists guarantees only remote file checks, and SSH/Docker implement it with test -f,
  // so directory existence and chmod must be checked together in one remote shell command.
  params.loggers.logWarn(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 检查并修复旧 builtin plugin 目录权限 ${params.remoteOfficialPluginDir}`,
  );
  const quotedRemoteOfficialPluginDir = quotePosixPathArg(params.remoteOfficialPluginDir);
  const stream = await params.backend.exec(
    `if [ -d ${quotedRemoteOfficialPluginDir} ]; then command chmod -R u+rwX ${quotedRemoteOfficialPluginDir}; fi`,
  );
  try {
    await waitForClose(stream);
    return true;
  } catch (error) {
    // chmod is only a pre-repair for directories with bad permissions on older WSL installs; actual deployment success is determined by the later packages replacement.
    // Some SSH/Docker mounted volumes or ACL environments may reject chmod even though the rm/tar replacement path can still succeed.
    params.loggers.logWarn(
      `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 修复旧 builtin plugin 目录权限失败，将继续尝试替换 packages: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
