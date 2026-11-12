export interface RemoteServerBundleValidationInput {
  bundledInputs: string[];
  source: string;
}

// keyring 需要按目标平台加载原生模块，不能被 esbuild 展开成所有平台的 .node 文件。
export const REMOTE_SERVER_NATIVE_EXTERNALS = ["@napi-rs/keyring"];

const unresolvedUndiciRuntimeImportPattern = /\b(?:require|import)\d*\(["']undici["']\)/;

export function validateRemoteServerBundle({ source }: RemoteServerBundleValidationInput): void {
  const hasUnresolvedUndiciRuntimeImport = unresolvedUndiciRuntimeImportPattern.test(source);

  if (hasUnresolvedUndiciRuntimeImport) {
    // Remote deployment uploads only a single zcode-server.cjs file to ~/.zcode/server/.
    // A bare undici runtime import remaining in the bundle is the only evidence that the remote still depends on node_modules;
    // if the current code no longer uses undici, do not mistake "unused dependency" for "dependency not bundled".
    throw new Error(
      'Remote server bundle must inline undici. Found unresolved runtime dependency "undici".',
    );
  }
}
