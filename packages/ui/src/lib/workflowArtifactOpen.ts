/**
 * Determines where a click on an HTML artifact should open.
 *
 * An HTML artifact pill means “show me this page,” not “show me its metadata card, then make me
 * click again to see the page.” So whenever it **can** open directly in the embedded browser, do so; the artifact tab is the fallback.
 * Its criteria share a source with `shouldOpenAssistantHtmlInBrowser` (lib/assistantPreviewCards.ts):
 *
 * - `text/html` must match exactly, the same gate used to render HTML cards in `WorkflowArtifactBody`.
 *   Accepting broader values such as `text/html; charset=utf-8` would make the direct-open check diverge from whether the card has that button.
 * - Without an embedded browser (Web/mobile remote control), `handleOpenBrowserUrl` only calls `window.open`,
 *   where `file://` cannot open—so fall back to the artifact tab.
 * - For remote workspaces (SSH / WSL / Docker) and mobile remote control, `sourcePath` does not exist locally, as with `canRevealArtifactInWorkspace`.
 *
 * If `contentType` is absent (older CLI, cold recovery, or a surface that does not carry a summary), always fall back to the artifact tab: when it cannot be determined,
 * use the existing path and never guess.
 */
export function shouldOpenWorkflowArtifactInBrowser(params: {
  contentType?: string;
  supportsEmbeddedBrowser: boolean;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): boolean {
  return (
    params.contentType === "text/html" &&
    params.supportsEmbeddedBrowser &&
    !params.workspaceIdentity?.trim() &&
    !params.remoteSessionId
  );
}
