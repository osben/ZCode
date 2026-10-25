import type { AppSettings } from "@zcode/shared";

export function normalizeSettingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const normalizedPatch = { ...patch };

  if (
    "locale" in normalizedPatch &&
    !("localePreference" in normalizedPatch) &&
    typeof normalizedPatch.locale === "string"
  ) {
    // locale now represents only the resolved language, while localePreference represents the user's preference.
    // For compatibility with older callers that set only locale, treat it as an explicit fixed-language choice so the next startup does not revert to system.
    normalizedPatch.localePreference = normalizedPatch.locale;
  }

  if (
    "terminalFontFamily" in normalizedPatch &&
    typeof normalizedPatch.terminalFontFamily === "string"
  ) {
    // Terminal font overrides must support clearing the value to return to automatic detection from the system profile.
    // RPC transport drops undefined, so normalize an empty string to undefined to avoid keeping the old font.
    const trimmedTerminalFontFamily = normalizedPatch.terminalFontFamily.trim();
    normalizedPatch.terminalFontFamily =
      trimmedTerminalFontFamily.length > 0 ? trimmedTerminalFontFamily : undefined;
  }

  if ("integratedTerminalShell" in normalizedPatch) {
    const selection = normalizedPatch.integratedTerminalShell;
    if (selection?.mode === "auto") {
      // “Automatic” in Settings removes the user override so the Bash execution layer can continue using platform auto-detection.
      normalizedPatch.integratedTerminalShell = undefined;
    } else if (selection?.mode === "shell") {
      normalizedPatch.integratedTerminalShell = {
        ...selection,
        id: selection.id.trim(),
        label: selection.label.trim(),
        path: selection.path.trim(),
      };
    }
  }

  if ("httpProxy" in normalizedPatch && typeof normalizedPatch.httpProxy === "string") {
    // Clearing the proxy now means explicitly connecting directly; do not fall back to user shell environment variables.
    // RPC drops undefined, so normalize an empty string to undefined to avoid retaining the old proxy in setting.json.
    const trimmedHttpProxy = normalizedPatch.httpProxy.trim();
    normalizedPatch.httpProxy = trimmedHttpProxy.length > 0 ? trimmedHttpProxy : undefined;
  }

  if (
    "httpProxyNoProxy" in normalizedPatch &&
    typeof normalizedPatch.httpProxyNoProxy === "string"
  ) {
    // No Proxy is part of the proxy policy and its old value must be deleted when cleared;
    // otherwise the agent/renderer will continue bypassing the explicit proxy on the next startup.
    const trimmedHttpProxyNoProxy = normalizedPatch.httpProxyNoProxy.trim();
    normalizedPatch.httpProxyNoProxy =
      trimmedHttpProxyNoProxy.length > 0 ? trimmedHttpProxyNoProxy : undefined;
  }

  if (
    "httpProxyCaCertPath" in normalizedPatch &&
    typeof normalizedPatch.httpProxyCaCertPath === "string"
  ) {
    // A custom CA must come from an explicit path in Settings. Delete the old value when the input is cleared;
    // otherwise the agent will continue injecting NODE_EXTRA_CA_CERTS after restart.
    const trimmedHttpProxyCaCertPath = normalizedPatch.httpProxyCaCertPath.trim();
    normalizedPatch.httpProxyCaCertPath =
      trimmedHttpProxyCaCertPath.length > 0 ? trimmedHttpProxyCaCertPath : undefined;
  }

  if (
    "zcodeEndpointOrigin" in normalizedPatch &&
    typeof normalizedPatch.zcodeEndpointOrigin === "string"
  ) {
    // Non-production endpoint overrides must support clearing via Reset; when RPC/JSON handling of undefined is unstable, an empty string still restores the default production domain.
    const trimmedZCodeEndpointOrigin = normalizedPatch.zcodeEndpointOrigin.trim();
    normalizedPatch.zcodeEndpointOrigin =
      trimmedZCodeEndpointOrigin.length > 0 ? trimmedZCodeEndpointOrigin : undefined;
  }

  if (
    "providerFamilyDomain" in normalizedPatch &&
    typeof normalizedPatch.providerFamilyDomain === "string"
  ) {
    // Clear the runtime scope when signing out or unbinding the current provider family.
    // RPC transport drops undefined, so normalize an empty string to undefined to prevent the old selection from affecting registry filtering.
    const trimmedProviderFamilyDomain = normalizedPatch.providerFamilyDomain.trim();
    normalizedPatch.providerFamilyDomain =
      trimmedProviderFamilyDomain.length > 0 ? normalizedPatch.providerFamilyDomain : undefined;
  }

  if (
    "dynamicWorkflowMode" in normalizedPatch &&
    (normalizedPatch.dynamicWorkflowMode as string | undefined) === ""
  ) {
    // docs/dynamic-workflow/launch.md, "The user's choice": selecting the server-provided mode
    // again is equivalent to deleting the choice, so installation keeps following server flips.
    // RPC drops undefined, so normalize the empty-string sentinel to deletion.
    normalizedPatch.dynamicWorkflowMode = undefined;
  }

  if (
    "worktreeCustomLocationPath" in normalizedPatch &&
    typeof normalizedPatch.worktreeCustomLocationPath === "string"
  ) {
    // The custom worktree location must be an explicit path; clearing the field returns the flow
    // to the sibling convention. RPC drops undefined, so an empty string is normalized to deletion.
    const trimmedWorktreeCustomLocationPath = normalizedPatch.worktreeCustomLocationPath.trim();
    normalizedPatch.worktreeCustomLocationPath =
      trimmedWorktreeCustomLocationPath.length > 0 ? trimmedWorktreeCustomLocationPath : undefined;
  }

  if (
    "worktreeBranchPrefix" in normalizedPatch &&
    typeof normalizedPatch.worktreeBranchPrefix === "string"
  ) {
    // “Reset to default” clears the branch prefix; keep the old value out of setting.json.
    const trimmedWorktreeBranchPrefix = normalizedPatch.worktreeBranchPrefix.trim();
    normalizedPatch.worktreeBranchPrefix =
      trimmedWorktreeBranchPrefix.length > 0 ? trimmedWorktreeBranchPrefix : undefined;
  }

  return normalizedPatch;
}
