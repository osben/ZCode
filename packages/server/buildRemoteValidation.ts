export interface RemoteServerBundleValidationInput {
  bundledInputs: string[];
  source: string;
}

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
